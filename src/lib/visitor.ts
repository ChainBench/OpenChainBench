import { z } from "zod";

const VISITOR_COOKIE = "ocb_vid";
const VISITOR_COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
const MAX_ID_LENGTH = 200;

const id = z.string().min(1).max(MAX_ID_LENGTH);

const posthogCookie = z.object({
  distinct_id: id,
  $sesid: z.tuple([z.number(), id, z.number()]).optional().catch(undefined),
});

export type Visitor = {
  distinctId: string;
  sessionId: string | null;
  source: "posthog" | "go";
};

export type GoVisitor = Visitor & { source: "go" };

function cookieValue(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function parseCookieJson(raw: string): unknown {
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function posthogVisitor(header: string, name: string): Visitor | null {
  const raw = cookieValue(header, name);
  if (raw === null) return null;
  const parsed = posthogCookie.safeParse(parseCookieJson(raw));
  if (!parsed.success) return null;
  const session = parsed.data.$sesid;
  const now = Date.now();
  const active =
    session &&
    now - session[0] < SESSION_IDLE_MS &&
    now - session[2] < SESSION_MAX_MS;
  return {
    distinctId: parsed.data.distinct_id,
    sessionId: active ? session[1] : null,
    source: "posthog",
  };
}

function goVisitor(header: string): GoVisitor | null {
  const parsed = z.uuid().safeParse(cookieValue(header, VISITOR_COOKIE));
  if (!parsed.success) return null;
  return { distinctId: parsed.data, sessionId: null, source: "go" };
}

export function readVisitors(
  cookieHeader: string | null,
  posthogCookieName: string | null,
): Visitor[] {
  if (!cookieHeader) return [];
  const posthog = posthogCookieName
    ? posthogVisitor(cookieHeader, posthogCookieName)
    : null;
  return [posthog, goVisitor(cookieHeader)].filter((v) => v !== null);
}

export function newVisitor(): GoVisitor {
  return { distinctId: crypto.randomUUID(), sessionId: null, source: "go" };
}

export function visitorCookie(visitor: GoVisitor): string {
  return [
    `${VISITOR_COOKIE}=${visitor.distinctId}`,
    `Max-Age=${VISITOR_COOKIE_MAX_AGE_SEC}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}
