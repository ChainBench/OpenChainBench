/**
 * Google Search Console, read with a service account (no OAuth dance):
 * the account's email is added as a user of the property, the JSON key
 * sits in GSC_SERVICE_ACCOUNT_JSON. Five Search Analytics calls per refresh
 * (daily series, pages and queries for the last window and the previous
 * one), well under the API's 1,200 calls per minute.
 *
 * Search Console data lags two to three days, so "last 7 days" here ends
 * three days ago; the window is shown on the page.
 */
import { createSign } from "node:crypto";
import { z } from "zod";

const SITE_URL = process.env.GSC_SITE_URL ?? "sc-domain:openchainbench.com";
const DELAY_DAYS = 3;
const WINDOW_DAYS = 7;

const saSchema = z.object({ client_email: z.string(), private_key: z.string(), token_uri: z.string().default("https://oauth2.googleapis.com/token") });

export function gscConfigured(): boolean {
  return (process.env.GSC_SERVICE_ACCOUNT_JSON ?? "").length > 0;
}

function b64url(s: Buffer | string): string {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let tokenCache: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const sa = saSchema.parse(JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON ?? "{}"));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly", aud: sa.token_uri, iat: now, exp: now + 3600 }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`gsc token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

const rowSchema = z.object({ keys: z.array(z.string()).optional(), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() });
const respSchema = z.object({ rows: z.array(rowSchema).optional() });
type Row = z.infer<typeof rowSchema>;

async function query(body: Record<string, unknown>): Promise<Row[]> {
  const token = await accessToken();
  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "web", dataState: "final", ...body }),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`gsc query ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return respSchema.parse(await res.json()).rows ?? [];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number, now: number) => iso(new Date(now - n * 86_400_000));

export type GscTotals = { clicks: number; impressions: number; ctr: number; position: number };
export type GscDim = GscTotals & { key: string; prevClicks: number; prevImpressions: number; prevPosition: number };
export type Gsc = {
  siteUrl: string;
  window: { start: string; end: string; prevStart: string; prevEnd: string };
  daily: (GscTotals & { date: string })[];
  totals: GscTotals & { prev: GscTotals };
  pages: GscDim[];
  queries: GscDim[];
  /** Pages with many impressions and a click-through below 1 % inside the top 15: the title/description work list. */
  opportunities: GscDim[];
};

/** Page keys come back as absolute URLs; for a domain property Google reports
 *  every host and scheme (www, http). All of them map to the site path. */
export function pageKeyStripper(siteUrl: string): (k: string) => string {
  const domain = siteUrl.startsWith("sc-domain:") ? siteUrl.slice("sc-domain:".length) : new URL(siteUrl).host.replace(/^www\./, "");
  const re = new RegExp(`^https?://(?:[a-z0-9-]+\\.)*${domain.replace(/\./g, "\\.")}(?::\\d+)?`, "i");
  return (k: string) => {
    const stripped = k.replace(re, "");
    return stripped === k ? k : stripped || "/";
  };
}

function totals(rows: Row[]): GscTotals {
  const clicks = rows.reduce((a, r) => a + r.clicks, 0);
  const impressions = rows.reduce((a, r) => a + r.impressions, 0);
  const position = impressions > 0 ? rows.reduce((a, r) => a + r.position * r.impressions, 0) / impressions : 0;
  return { clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position };
}

/** Rows keyed after stripping (www and http variants of a page fold into one),
 *  clicks and impressions summed, position impression-weighted. */
function foldRows(rows: Row[], strip: (k: string) => string): Map<string, GscTotals> {
  const out = new Map<string, { clicks: number; impressions: number; posW: number }>();
  for (const r of rows) {
    const k = strip(r.keys?.[0] ?? "");
    const cur = out.get(k) ?? { clicks: 0, impressions: 0, posW: 0 };
    cur.clicks += r.clicks;
    cur.impressions += r.impressions;
    cur.posW += r.position * r.impressions;
    out.set(k, cur);
  }
  return new Map(
    [...out.entries()].map(([k, v]) => [k, { clicks: v.clicks, impressions: v.impressions, ctr: v.impressions > 0 ? v.clicks / v.impressions : 0, position: v.impressions > 0 ? v.posW / v.impressions : 0 }]),
  );
}

function joinWindows(cur: Row[], prev: Row[], strip: (k: string) => string): GscDim[] {
  const prevBy = foldRows(prev, strip);
  return [...foldRows(cur, strip).entries()]
    .map(([key, v]) => {
      const p = prevBy.get(key);
      return { key, ...v, prevClicks: p?.clicks ?? 0, prevImpressions: p?.impressions ?? 0, prevPosition: p?.position ?? 0 };
    })
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

export async function loadGsc(now = Date.now()): Promise<Gsc> {
  const end = daysAgo(DELAY_DAYS, now);
  const start = daysAgo(DELAY_DAYS + WINDOW_DAYS - 1, now);
  const prevEnd = daysAgo(DELAY_DAYS + WINDOW_DAYS, now);
  const prevStart = daysAgo(DELAY_DAYS + 2 * WINDOW_DAYS - 1, now);
  const seriesStart = daysAgo(DELAY_DAYS + 27, now);
  const stripOrigin = pageKeyStripper(SITE_URL);

  const daily = await query({ startDate: seriesStart, endDate: end, dimensions: ["date"], rowLimit: 60 });
  const pagesCur = await query({ startDate: start, endDate: end, dimensions: ["page"], rowLimit: 500 });
  const pagesPrev = await query({ startDate: prevStart, endDate: prevEnd, dimensions: ["page"], rowLimit: 500 });
  const queriesCur = await query({ startDate: start, endDate: end, dimensions: ["query"], rowLimit: 300 });
  const queriesPrev = await query({ startDate: prevStart, endDate: prevEnd, dimensions: ["query"], rowLimit: 300 });

  const inWindow = (r: Row) => (r.keys?.[0] ?? "") >= start && (r.keys?.[0] ?? "") <= end;
  const inPrev = (r: Row) => (r.keys?.[0] ?? "") >= prevStart && (r.keys?.[0] ?? "") <= prevEnd;
  const pages = joinWindows(pagesCur, pagesPrev, stripOrigin);
  return {
    siteUrl: SITE_URL,
    window: { start, end, prevStart, prevEnd },
    daily: daily.map((r) => ({ date: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
    totals: { ...totals(daily.filter(inWindow)), prev: totals(daily.filter(inPrev)) },
    pages,
    queries: joinWindows(queriesCur, queriesPrev, (k) => k),
    opportunities: pages.filter((p) => p.impressions >= 50 && p.ctr < 0.01 && p.position <= 15).sort((a, b) => b.impressions - a.impressions).slice(0, 30),
  };
}
