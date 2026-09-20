/**
 * Vercel Log Drain receiver: the server side the browser SDK cannot see.
 * AI crawlers (GPTBot, ClaudeBot, PerplexityBot, …), search bots, 404s,
 * hits on /api/stat, /api/citable and llms.txt, cache hit ratio.
 *
 * Every request Vercel serves arrives as one JSON entry with a `proxy`
 * block. Entries are folded into a per-UTC-day aggregate in memory and
 * flushed to SNAPSHOT_DIR/vercel/YYYY-MM-DD.json once a minute (merged with
 * what is already on disk, so a restart loses at most a minute). Nothing
 * per-request is stored: no IPs, no full user agents.
 *
 * Setup (Vercel dashboard, team owner): Settings → Log Drains → add,
 * source "Request logs" (proxy), format JSON, endpoint
 * https://<crm>/api/ingest/vercel, custom secret = VERCEL_LOG_DRAIN_SECRET.
 * Vercel verifies the endpoint once with `x-vercel-verify`; the value it
 * expects back is VERCEL_LOG_DRAIN_VERIFY.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { classifyPath, type Section } from "@/lib/channels";

const DIR = path.join(process.env.SNAPSHOT_DIR ?? path.join(process.cwd(), ".snapshots"), "vercel");
const SITE_HOST = process.env.SITE_HOST ?? "openchainbench.com";

export const AI_BOTS: [RegExp, string][] = [
  [/GPTBot/i, "GPTBot"],
  [/ChatGPT-User/i, "ChatGPT-User"],
  [/OAI-SearchBot/i, "OAI-SearchBot"],
  [/ClaudeBot|Claude-Web|anthropic-ai|Claude-User|Claude-SearchBot/i, "ClaudeBot"],
  [/PerplexityBot|Perplexity-User/i, "PerplexityBot"],
  [/Google-Extended/i, "Google-Extended"],
  [/GoogleOther/i, "GoogleOther"],
  [/Applebot-Extended/i, "Applebot-Extended"],
  [/Bytespider/i, "Bytespider"],
  [/CCBot/i, "CCBot"],
  [/cohere-ai|cohere-training/i, "Cohere"],
  [/Amazonbot/i, "Amazonbot"],
  [/meta-externalagent|meta-externalfetcher|FacebookBot/i, "Meta"],
  [/Diffbot/i, "Diffbot"],
  [/YouBot/i, "YouBot"],
  [/DuckAssistBot/i, "DuckAssistBot"],
  [/MistralAI-User/i, "MistralAI"],
  [/xAI-Grok|GrokBot/i, "Grok"],
  [/Timpibot/i, "Timpibot"],
  [/omgili|webzio/i, "Webz"],
];
export const SEARCH_BOTS: [RegExp, string][] = [
  [/Googlebot|Google-InspectionTool|Storebot-Google|AdsBot-Google|Mediapartners-Google/i, "Googlebot"],
  [/bingbot|BingPreview|msnbot/i, "Bingbot"],
  [/DuckDuckBot/i, "DuckDuckBot"],
  [/YandexBot|YandexImages/i, "Yandex"],
  [/Baiduspider/i, "Baidu"],
  [/Applebot/i, "Applebot"],
  [/Slurp/i, "Yahoo"],
  [/SeznamBot/i, "Seznam"],
  [/PetalBot/i, "PetalBot"],
];
const GENERIC_BOT = /bot|crawl|spider|slurp|fetch|curl\/|wget|python-requests|python-urllib|aiohttp|httpx|go-http-client|java\/|okhttp|axios|node-fetch|undici|libwww|scrapy|headless|phantom|lighthouse|pagespeed|uptime|monitor|pingdom|datadog|newrelic|ahrefs|semrush|mj12|dotbot|screaming/i;

export type UaClass = { kind: "human" | "ai_bot" | "search_bot" | "other_bot"; name: string };

export function classifyUserAgent(ua: string | null | undefined): UaClass {
  const s = ua ?? "";
  if (!s) return { kind: "other_bot", name: "empty" };
  for (const [re, name] of AI_BOTS) if (re.test(s)) return { kind: "ai_bot", name };
  for (const [re, name] of SEARCH_BOTS) if (re.test(s)) return { kind: "search_bot", name };
  if (GENERIC_BOT.test(s)) return { kind: "other_bot", name: "other" };
  return { kind: "human", name: "human" };
}

/** Paths the machine side of the site serves; everything else is "page". */
export function apiFamily(p: string): string | null {
  if (p.startsWith("/api/stat")) return "/api/stat";
  if (p.startsWith("/api/citable")) return "/api/citable";
  if (p === "/llms.txt" || p === "/llms-full.txt") return "/llms.txt";
  if (p.startsWith("/api/og")) return "/api/og";
  if (p.endsWith("sitemap.xml") || p === "/robots.txt") return "/sitemap+robots";
  if (p === "/rss.xml" || p === "/feed.json") return "/feeds";
  if (p.startsWith("/api/mcp") || p.startsWith("/mcp/")) return "/api/mcp";
  if (p.startsWith("/api/")) return "/api/other";
  return null;
}

export type DayAggregate = {
  day: string;
  requests: number;
  byClass: Record<string, number>;
  aiBots: Record<string, number>;
  searchBots: Record<string, number>;
  aiBySection: Record<string, number>;
  humanBySection: Record<string, number>;
  status: Record<string, number>;
  notFound: Record<string, number>;
  api: Record<string, Record<string, number>>;
  cache: Record<string, number>;
  updatedAt: string;
};

export function emptyDay(day: string): DayAggregate {
  return { day, requests: 0, byClass: {}, aiBots: {}, searchBots: {}, aiBySection: {}, humanBySection: {}, status: {}, notFound: {}, api: {}, cache: {}, updatedAt: new Date().toISOString() };
}

const inc = (m: Record<string, number>, k: string, n = 1) => {
  m[k] = (m[k] ?? 0) + n;
};

/** One Vercel drain entry (only the fields read here). */
export type DrainEntry = {
  id?: string;
  requestId?: string;
  timestamp?: number;
  source?: string;
  host?: string;
  path?: string;
  statusCode?: number;
  proxy?: {
    timestamp?: number;
    path?: string;
    host?: string;
    userAgent?: string[] | string;
    statusCode?: number;
    vercelCache?: string;
    pathType?: string;
  };
};

export function foldEntry(agg: DayAggregate, e: DrainEntry): boolean {
  const p = e.proxy;
  if (!p) return false;
  const host = (p.host ?? e.host ?? "").toLowerCase();
  if (host && host !== SITE_HOST && host !== `www.${SITE_HOST}`) return false;
  const rawPath = (p.path ?? e.path ?? "/").split("?")[0];
  if (rawPath.startsWith("/_next/") || rawPath.startsWith("/ingest/") || /\.(js|css|png|jpg|jpeg|svg|ico|woff2?|map|webp|avif|gif)$/i.test(rawPath)) return false;
  const ua = Array.isArray(p.userAgent) ? p.userAgent.join(" ") : (p.userAgent ?? "");
  const cls = classifyUserAgent(ua);
  const status = p.statusCode ?? e.statusCode ?? 0;
  agg.requests += 1;
  inc(agg.byClass, cls.kind);
  inc(agg.status, String(status || "0"));
  if (p.vercelCache) inc(agg.cache, p.vercelCache);
  const fam = apiFamily(rawPath);
  if (fam) {
    agg.api[fam] ??= {};
    inc(agg.api[fam], cls.kind);
  }
  const section: Section = classifyPath(rawPath);
  if (cls.kind === "ai_bot") {
    inc(agg.aiBots, cls.name);
    if (!fam) inc(agg.aiBySection, section);
  } else if (cls.kind === "search_bot") {
    inc(agg.searchBots, cls.name);
  } else if (cls.kind === "human" && !fam) {
    inc(agg.humanBySection, section);
  }
  if (status === 404 && Object.keys(agg.notFound).length < 500) inc(agg.notFound, rawPath.slice(0, 160));
  else if (status === 404) inc(agg.notFound, "(other)");
  agg.updatedAt = new Date().toISOString();
  return true;
}

export function mergeDay(a: DayAggregate, b: DayAggregate): DayAggregate {
  const out = emptyDay(a.day);
  out.requests = a.requests + b.requests;
  const mergeMap = (x: Record<string, number>, y: Record<string, number>) => {
    const m: Record<string, number> = { ...x };
    for (const [k, v] of Object.entries(y)) inc(m, k, v);
    return m;
  };
  out.byClass = mergeMap(a.byClass, b.byClass);
  out.aiBots = mergeMap(a.aiBots, b.aiBots);
  out.searchBots = mergeMap(a.searchBots, b.searchBots);
  out.aiBySection = mergeMap(a.aiBySection, b.aiBySection);
  out.humanBySection = mergeMap(a.humanBySection, b.humanBySection);
  out.status = mergeMap(a.status, b.status);
  out.notFound = mergeMap(a.notFound, b.notFound);
  out.cache = mergeMap(a.cache, b.cache);
  for (const fam of new Set([...Object.keys(a.api), ...Object.keys(b.api)])) out.api[fam] = mergeMap(a.api[fam] ?? {}, b.api[fam] ?? {});
  out.updatedAt = a.updatedAt > b.updatedAt ? a.updatedAt : b.updatedAt;
  return out;
}

// In-memory accumulator on globalThis (route handlers and the flusher can
// live in different bundler layers), plus a bounded request-id set so a
// request that produces two entries (proxy plus function log) counts once.
type State = { days: Map<string, DayAggregate>; seen: Set<string>; seenOrder: string[]; flushTimer: ReturnType<typeof setInterval> | null; received: number };
const g = globalThis as unknown as { __ocbVercelLogs?: State };
const state: State = (g.__ocbVercelLogs ??= { days: new Map(), seen: new Set(), seenOrder: [], flushTimer: null, received: 0 });
const SEEN_MAX = 100_000;

export function ingestEntries(entries: DrainEntry[], now = Date.now()): number {
  let folded = 0;
  for (const e of entries) {
    const rid = e.requestId ?? e.id;
    if (rid) {
      if (state.seen.has(rid)) continue;
      state.seen.add(rid);
      state.seenOrder.push(rid);
      if (state.seenOrder.length > SEEN_MAX) {
        const old = state.seenOrder.splice(0, state.seenOrder.length - SEEN_MAX);
        for (const o of old) state.seen.delete(o);
      }
    }
    const ts = e.proxy?.timestamp ?? e.timestamp ?? now;
    const day = new Date(ts).toISOString().slice(0, 10);
    const agg = state.days.get(day) ?? emptyDay(day);
    if (foldEntry(agg, e)) {
      state.days.set(day, agg);
      folded += 1;
    }
  }
  state.received += entries.length;
  armFlush();
  return folded;
}

function armFlush(): void {
  if (state.flushTimer) return;
  state.flushTimer = setInterval(() => {
    flush().catch((e) => console.warn("[vercel-logs] flush:", e));
  }, 60_000);
  state.flushTimer.unref?.();
}

export async function flush(): Promise<void> {
  if (state.days.size === 0) return;
  const pending = [...state.days.values()];
  state.days.clear();
  await fs.mkdir(DIR, { recursive: true });
  for (const agg of pending) {
    const file = path.join(DIR, `${agg.day}.json`);
    let onDisk: DayAggregate | null = null;
    try {
      onDisk = JSON.parse(await fs.readFile(file, "utf8")) as DayAggregate;
    } catch {
      // first write of the day
    }
    const merged = onDisk ? mergeDay(onDisk, agg) : agg;
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(merged));
    await fs.rename(tmp, file);
  }
}

export async function readDays(n = 28, now = Date.now()): Promise<DayAggregate[]> {
  const out: DayAggregate[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    let agg: DayAggregate | null = null;
    try {
      agg = JSON.parse(await fs.readFile(path.join(DIR, `${day}.json`), "utf8")) as DayAggregate;
    } catch {
      // no traffic recorded that day
    }
    const live = state.days.get(day);
    if (agg && live) agg = mergeDay(agg, live);
    else if (live) agg = live;
    if (agg) out.push(agg);
  }
  return out;
}

export function drainConfigured(): boolean {
  return (process.env.VERCEL_LOG_DRAIN_SECRET ?? "").length >= 16;
}

/** Vercel signs the raw body with HMAC-SHA1 under the drain secret (`x-vercel-signature`). */
export function verifySignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.VERCEL_LOG_DRAIN_SECRET ?? "";
  if (!signature || secret.length < 16) return false;
  const expected = createHmac("sha1", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim().toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Vercel drains send either a JSON array or newline-delimited JSON. */
export function parseBody(raw: string): DrainEntry[] {
  const t = raw.trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t);
      return Array.isArray(arr) ? (arr as DrainEntry[]) : [];
    } catch {
      return [];
    }
  }
  const out: DrainEntry[] = [];
  for (const line of t.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DrainEntry);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

export function drainStats(): { received: number; pendingDays: number } {
  return { received: state.received, pendingDays: state.days.size };
}
