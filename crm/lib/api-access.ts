import {
  type AccessStatus,
  TEAM_ROUTE,
  statusLink,
} from "./api-access-contract/contract";
import {
  ADMIN_TOKEN_ENV,
  type TeamAction,
  type TeamList,
  type TeamRefusal,
  type TeamView,
  teamActedSchema,
  teamCallRefusalSchema,
  teamListSchema,
  teamRefusalSchema,
} from "./api-access-contract/team-contract";
import { ACCESS_SITE_ORIGIN } from "./site";

export const SITE_TIMEOUT_SECONDS = 10;
const PARALLEL_CALLS = 8;

const SITE_FAILURES = [
  "unconfigured",
  "unauthorized",
  "unreachable",
  "unavailable",
  "bad_answer",
  "site_error",
  "redirected",
  "no_route",
] as const;
export type SiteFailure = (typeof SITE_FAILURES)[number];

export type Listed =
  | ({ ok: true } & TeamList)
  | { ok: false; error: SiteFailure };
export type Acted =
  | { ok: true; request: TeamView; link: string | null }
  | { ok: false; error: SiteFailure | TeamRefusal };

type Site = { origin: string; token: string };
type Read = { status: number; body: unknown; text: string };
type Answer = Read | SiteFailure;

const MAX_LOGGED_BODY = 200;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callSite(
  site: Site,
  path: string,
  init: RequestInit,
): Promise<Answer> {
  if (!site.token) return "unconfigured";
  let res: Response;
  try {
    res = await fetch(`${site.origin}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${site.token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(SITE_TIMEOUT_SECONDS * 1000),
    });
  } catch (err) {
    console.error("api access site call failed", path, err);
    return "unreachable";
  }
  if (res.status >= 300 && res.status < 400) {
    console.error("api access site redirected", path, res.status,
      res.headers.get("location"));
    return "redirected";
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    console.error("api access site answer cut off", path, res.status, err);
    return "unreachable";
  }
  return classified(path, res.status, text);
}

function classified(path: string, status: number, text: string): Answer {
  const body: unknown = parseJson(text);
  if (status === 401 || status === 503) {
    const refused = teamCallRefusalSchema.safeParse(body);
    if (refused.success) return refused.data.error;
    console.error("api access site refused", path, status,
      text.slice(0, MAX_LOGGED_BODY));
    return "site_error";
  }
  const refusal = teamRefusalSchema.safeParse(body).success;
  if (status === 404 && !refusal) {
    console.error("api access site has no team route", path);
    return "no_route";
  }
  if (status >= 400 && !refusal) {
    console.error("api access site error", path, status,
      text.slice(0, MAX_LOGGED_BODY));
    return "site_error";
  }
  return { status, body, text };
}

function badAnswer(
  what: string,
  answer: Read,
  issues: readonly { path: PropertyKey[]; code: string }[],
): { ok: false; error: "bad_answer" } {
  const notJson = answer.body === null ? answer.text : "";
  const where = issues.map((i) =>
    `${i.path.map(String).join(".")}: ${i.code}`);
  console.error(`api access ${what} unreadable`, answer.status, where,
    notJson.slice(0, MAX_LOGGED_BODY));
  return { ok: false, error: "bad_answer" };
}

export const isSiteFailure = (error: string): error is SiteFailure =>
  SITE_FAILURES.some((f) => f === error);
const stopsBatch = (acted: Acted) => !acted.ok && isSiteFailure(acted.error);

export function createAccessClient(site: Site) {
  async function listAccessRequests(status: AccessStatus): Promise<Listed> {
    const path = `${TEAM_ROUTE}?status=${status}`;
    const answer = await callSite(site, path, { method: "GET" });
    if (typeof answer === "string") return { ok: false, error: answer };
    const parsed = teamListSchema.safeParse(answer.body);
    if (answer.status !== 200 || !parsed.success) {
      const issues = parsed.success ? [] : parsed.error.issues;
      return badAnswer("list", answer, issues);
    }
    return { ok: true, ...parsed.data };
  }

  async function actOnRequest(id: string, action: TeamAction): Promise<Acted> {
    const answer = await callSite(
      site,
      `${TEAM_ROUTE}/${encodeURIComponent(id)}`,
      { method: "POST", body: JSON.stringify(action) },
    );
    if (typeof answer === "string") return { ok: false, error: answer };
    const acted = teamActedSchema.safeParse(answer.body);
    if (answer.status === 200 && acted.success) {
      const { request, token } = acted.data;
      if (action.action === "reissue_link" && !token) {
        console.error("api access new link missing from the answer", id);
        return { ok: false, error: "bad_answer" };
      }
      const link = token ? `${site.origin}${statusLink(token)}` : null;
      return { ok: true, request, link };
    }
    const refused = teamRefusalSchema.safeParse(answer.body);
    if (refused.success) return { ok: false, error: refused.data.error };
    const issues = acted.success ? [] : acted.error.issues;
    return badAnswer("action", answer, issues);
  }

  async function declineEach(ids: string[], reason: string): Promise<Acted[]> {
    const decline = (id: string) =>
      actOnRequest(id, { action: "decline", reason });
    const results: Acted[] = [];
    for (let start = 0; start < ids.length; start += PARALLEL_CALLS) {
      const batch = ids.slice(start, start + PARALLEL_CALLS);
      const answers = await Promise.all(batch.map(decline));
      results.push(...answers);
      if (answers.some(stopsBatch)) break;
    }
    return results;
  }

  return { listAccessRequests, actOnRequest, declineEach };
}

export const accessClient = () =>
  createAccessClient({
    origin: ACCESS_SITE_ORIGIN,
    token: (process.env[ADMIN_TOKEN_ENV] ?? "").trim(),
  });
