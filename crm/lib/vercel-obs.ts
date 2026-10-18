/**
 * Agent traffic, read from Vercel Observability rather than PostHog.
 *
 * PostHog cannot answer "who reads the site" and never will. Its client SDK
 * is JavaScript, so nothing that skips JS is ever in it, and the server-side
 * capture in src/lib/analytics-server.ts is wired to three routes only
 * (/api/md, /api/stat, /api/citable), two of which are cached (60 s and one
 * hour) and therefore emit one event per cache fill rather than per read.
 * Every HTML page is ISR-cached, so a crawler fetching /benchmarks/<slug>
 * runs no code of ours and appears nowhere.
 *
 * Measured on 2026-09-30: PostHog showed 19 reads from identified AI agents
 * over its whole history and attributed 65 % of "agent" traffic to our own
 * curl probes and Blackbox exporter. Vercel, over the same three days, counted
 * 75,429 requests from AI crawlers alone. The two are not close because they
 * are not measuring the same thing.
 *
 * So this file does not duplicate the collection. Vercel already records every
 * edge request with a classified bot, cache hits included; we query it.
 *
 * The API is `/v2/observability/query`, the one `vercel metrics` uses. It is
 * not in Vercel's public REST documentation, so the pieces worth keeping:
 *   - the filter dialect is OData: `environment eq 'production'`, single
 *     quotes, not `environment:production` (that is the CLI's own surface
 *     syntax, rejected by the API);
 *   - `orderBy` must name a rollup column, `vercel_request_count_sum`, not
 *     the aggregation;
 *   - grouped dimensions come back snake_cased (`bot_name`, `bot_category`)
 *     even though `groupBy` takes them camelCased;
 *   - `vercel metrics schema vercel.request.count` lists every dimension.
 *
 * Retention starts when the Observability entitlement was enabled on the team
 * (2026-09-28 here), so a 30-day window returns empty days before that.
 */
import { z } from "zod";

const API = "https://api.vercel.com/v2/observability/query";
const TIMEOUT_MS = 45_000;

const TOKEN = process.env.VERCEL_API_TOKEN ?? "";
const TEAM = process.env.VERCEL_TEAM_ID ?? "";
const PROJECT = process.env.VERCEL_PROJECT_ID ?? "";

/** Days of history each refresh asks for. Vercel bills nothing per query. */
const WINDOW_DAYS = Number.parseInt(process.env.AGENT_WINDOW_DAYS ?? "", 10) || 30;

/**
 * The per-path query is the expensive one and 408s over the full window
 * (`query_timeout` from Vercel, reproduced on 2026-09-30 at 31 days). Seven
 * days serves in a few seconds and is the right question anyway: what the
 * crawlers are reading now, not what they read a month ago.
 */
const PATHS_WINDOW_DAYS = Number.parseInt(process.env.AGENT_PATHS_WINDOW_DAYS ?? "", 10) || 7;

export function vercelObsConfigured(): boolean {
  return TOKEN.length > 0 && TEAM.length > 0 && PROJECT.length > 0;
}

/**
 * Vercel's own bot taxonomy, as returned in `botCategory`. Grouped here into
 * the three questions the dashboard actually asks, so a new category Vercel
 * adds shows up as itself rather than being silently folded into "other".
 */
const AI_CATEGORIES = new Set(["ai_crawler", "ai_assistant"]);
const SEARCH_CATEGORIES = new Set(["search_engine_crawler", "search_engine_optimization"]);

export type AgentBotRow = {
  bot: string;
  category: string;
  requests: number;
  /** Share of all classified bot requests in the window. */
  sharePct: number;
};
export type AgentCategoryRow = { category: string; requests: number };
export type AgentDay = { day: string; ai: number; search: number; unclassified: number; other: number };
export type AgentPathRow = { path: string; requests: number };

export type AgentTraffic = {
  /** Window asked for, and the first day that actually carried data. */
  windowDays: number;
  firstDayWithData: string | null;
  /** Every request Vercel logged on production in the window, bots included. */
  totalRequests: number;
  /** Requests whose bot category is an AI one. */
  aiRequests: number;
  /** Requests from AI bots excluding the single largest one, which on this
   *  site is a crawler in a loop and swamps every other signal. */
  aiRequestsExcludingTop: number;
  topAiBot: string | null;
  categories: AgentCategoryRow[];
  bots: AgentBotRow[];
  daily: AgentDay[];
  /** What the AI crawlers actually read, over a shorter window than the rest. */
  aiPathsWindowDays: number;
  aiPaths: AgentPathRow[];
};

const rowSchema = z.object({
  timestamp: z.string().optional(),
  vercel_request_count_sum: z.number(),
  bot_name: z.string().optional(),
  bot_category: z.string().optional(),
  request_path: z.string().optional(),
});
const responseSchema = z.object({ data: z.array(rowSchema) });

type Row = z.infer<typeof rowSchema>;

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
}

/**
 * One grouped query. `filter` is OData; see the header note.
 *
 * Granularity is always one day: the API rejects anything but 5m, 15m, 1h and
 * 1d (`Unsupported duration {"days":31}`), so a whole-window total cannot be
 * asked for and is summed from the daily buckets here instead. `limit` is
 * per bucket, not per result set, which is why it is generous.
 */
async function query(opts: {
  groupBy: string[];
  days: number;
  filter?: string;
  limit?: number;
}): Promise<Row[]> {
  const body = {
    scope: { type: "project", ownerId: TEAM, projectIds: [PROJECT] },
    metric: "vercel.request.count",
    selection: { aggregation: "count" },
    startTime: isoDay(-opts.days),
    endTime: isoDay(1),
    granularity: { days: 1 },
    groupBy: opts.groupBy,
    filter: opts.filter ?? "environment eq 'production'",
    limit: opts.limit ?? 40,
    orderBy: "vercel_request_count_sum",
    orderDirection: "desc",
  };
  const res = await fetch(API + `?teamId=${encodeURIComponent(TEAM)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`vercel observability ${res.status}: ${detail}`);
  }
  return responseSchema.parse(await res.json()).data;
}

export async function loadAgentTraffic(): Promise<AgentTraffic> {
  if (!vercelObsConfigured()) {
    throw new Error("VERCEL_API_TOKEN, VERCEL_TEAM_ID or VERCEL_PROJECT_ID not set");
  }

  const [daily, bots, aiPaths] = await Promise.all([
    query({ groupBy: ["botCategory"], days: WINDOW_DAYS, limit: 20 }),
    query({ groupBy: ["botName", "botCategory"], days: WINDOW_DAYS, limit: 40 }),
    query({
      groupBy: ["requestPath"],
      days: PATHS_WINDOW_DAYS,
      filter:
        "environment eq 'production' and (botCategory eq 'ai_crawler' or botCategory eq 'ai_assistant')",
      limit: 15,
    }),
  ]);
  return shapeAgentTraffic({ daily, bots, aiPaths, windowDays: WINDOW_DAYS, pathsWindowDays: PATHS_WINDOW_DAYS });
}

/**
 * The shaping, kept pure and exported so it can be tested without the network.
 *
 * Two decisions live here rather than in the view. A category the taxonomy
 * does not know (Vercel ships a dozen: browser_impersonation, http_client,
 * client_anomaly, ...) is carried through as itself instead of being folded
 * into "other", so a new one is visible the day it appears. And the AI total
 * is published twice, with and without the single largest AI bot, because one
 * crawler in a loop can be 84 % of it and a single number would read as
 * adoption.
 */
export function shapeAgentTraffic(input: {
  daily: Row[];
  bots: Row[];
  aiPaths: Row[];
  windowDays: number;
  pathsWindowDays: number;
}): AgentTraffic {
  const { daily, bots, aiPaths, windowDays: WINDOW_DAYS, pathsWindowDays: PATHS_WINDOW_DAYS } = input;

  // ── daily series, folded into the three questions ──
  const byDay = new Map<string, AgentDay>();
  for (const r of daily) {
    const day = (r.timestamp ?? "").slice(0, 10);
    if (!day) continue;
    const cat = r.bot_category ?? "";
    const d = byDay.get(day) ?? { day, ai: 0, search: 0, unclassified: 0, other: 0 };
    if (AI_CATEGORIES.has(cat)) d.ai += r.vercel_request_count_sum;
    else if (SEARCH_CATEGORIES.has(cat)) d.search += r.vercel_request_count_sum;
    else if (cat === "") d.unclassified += r.vercel_request_count_sum;
    else d.other += r.vercel_request_count_sum;
    byDay.set(day, d);
  }
  const series = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));

  // A day is "with data" once anything at all was logged: the window reaches
  // back past the day Observability was switched on, and those days are zero.
  const firstDayWithData =
    series.find((d) => d.ai + d.search + d.unclassified + d.other > 0)?.day ?? null;

  const categoryTotals = new Map<string, number>();
  for (const r of daily) {
    const cat = r.bot_category || "(unclassified)";
    categoryTotals.set(cat, (categoryTotals.get(cat) ?? 0) + r.vercel_request_count_sum);
  }

  // ── bots ──
  const botTotals = new Map<string, { category: string; requests: number }>();
  for (const r of bots) {
    const name = r.bot_name ?? "";
    if (!name) continue; // the unclassified bucket is not a bot
    const cur = botTotals.get(name) ?? { category: r.bot_category ?? "", requests: 0 };
    cur.requests += r.vercel_request_count_sum;
    if (!cur.category && r.bot_category) cur.category = r.bot_category;
    botTotals.set(name, cur);
  }
  const classifiedTotal = [...botTotals.values()].reduce((s, b) => s + b.requests, 0);
  const botRows: AgentBotRow[] = [...botTotals.entries()]
    .map(([bot, v]) => ({
      bot,
      category: v.category,
      requests: v.requests,
      sharePct: classifiedTotal > 0 ? (v.requests / classifiedTotal) * 100 : 0,
    }))
    .sort((a, b) => b.requests - a.requests);

  const aiBots = botRows.filter((b) => AI_CATEGORIES.has(b.category));
  const aiRequests = aiBots.reduce((s, b) => s + b.requests, 0);
  const topAiBot = aiBots[0]?.bot ?? null;
  const aiRequestsExcludingTop = aiRequests - (aiBots[0]?.requests ?? 0);

  return {
    windowDays: WINDOW_DAYS,
    firstDayWithData,
    totalRequests: daily.reduce((s, r) => s + r.vercel_request_count_sum, 0),
    aiRequests,
    aiRequestsExcludingTop,
    topAiBot,
    categories: [...categoryTotals.entries()]
      .map(([category, requests]) => ({ category, requests }))
      .sort((a, b) => b.requests - a.requests),
    bots: botRows,
    daily: series,
    aiPathsWindowDays: PATHS_WINDOW_DAYS,
    aiPaths: sumByPath(aiPaths),
  };
}

/** Daily buckets summed into one row per path; see the granularity note. */
function sumByPath(rows: Row[]): AgentPathRow[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.vercel_request_count_sum === 0) continue;
    const path = r.request_path || "/";
    totals.set(path, (totals.get(path) ?? 0) + r.vercel_request_count_sum);
  }
  return [...totals.entries()]
    .map(([path, requests]) => ({ path, requests }))
    .sort((a, b) => b.requests - a.requests);
}
