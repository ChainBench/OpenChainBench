/**
 * PostHog HogQL client with a spend budget.
 *
 * PostHog rate-limits the query endpoint at 2400 requests per hour for the
 * whole organisation (every key, every team member). This app never queries
 * in the request path: a refresh runs a fixed list of about a dozen queries,
 * one at a time, and the pages read the resulting snapshot. The budget below
 * is a second guard so a bug in a loop cannot spend the organisation's hour.
 * A 429 stops the batch for the Retry-After the server names; the sections
 * that did not run keep their previous values (see snapshot.ts).
 */
import { z } from "zod";

const HOST = (process.env.POSTHOG_HOST ?? "https://us.posthog.com").replace(/\/$/, "");
const PROJECT_ID = process.env.POSTHOG_PROJECT_ID ?? "";
const API_KEY = process.env.POSTHOG_PERSONAL_API_KEY ?? "";
const REQUEST_TIMEOUT_MS = 60_000;

/** PostHog's organisation-wide limit on the query endpoint, per hour. */
export const POSTHOG_ORG_LIMIT_PER_HOUR = 2400;

export function readBudgetLimit(raw: string | undefined, fallback = 300): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(POSTHOG_ORG_LIMIT_PER_HOUR, Math.max(1, n));
}

export const HOURLY_BUDGET = readBudgetLimit(process.env.POSTHOG_HOURLY_BUDGET);

export function posthogConfigured(): boolean {
  return API_KEY.length > 0 && PROJECT_ID.length > 0;
}

const responseSchema = z.object({
  results: z.array(z.array(z.unknown())),
  columns: z.array(z.string()).optional(),
});

export type HogQLRows = unknown[][];

/** Rolling-hour spend, kept in memory (one process, one refresher). */
export class Budget {
  private stamps: number[] = [];
  constructor(private readonly limit: number) {}
  /** Milliseconds until a slot frees, 0 when one is free now. */
  waitMs(now = Date.now()): number {
    this.stamps = this.stamps.filter((t) => now - t < 3_600_000);
    if (this.stamps.length < this.limit) return 0;
    return this.stamps[0] + 3_600_000 - now;
  }
  spend(now = Date.now()): void {
    this.stamps.push(now);
  }
  used(now = Date.now()): number {
    this.stamps = this.stamps.filter((t) => now - t < 3_600_000);
    return this.stamps.length;
  }
}

export const budget = new Budget(HOURLY_BUDGET);

export class RateLimited extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`posthog rate limited, retry after ${Math.round(retryAfterMs / 1000)} s`);
  }
}

export class BudgetExhausted extends Error {
  constructor(public readonly waitMs: number) {
    super(`local posthog budget exhausted, next slot in ${Math.round(waitMs / 1000)} s`);
  }
}

/** Serialises calls: two refreshes (interval plus manual) never run queries side by side. */
let chain: Promise<unknown> = Promise.resolve();

export function queryHogQL(name: string, query: string): Promise<HogQLRows> {
  const run = chain.then(() => queryOnce(name, query));
  chain = run.catch(() => undefined);
  return run;
}

async function queryOnce(name: string, query: string): Promise<HogQLRows> {
  if (!posthogConfigured()) throw new Error("posthog not configured");
  const wait = budget.waitMs();
  if (wait > 0) throw new BudgetExhausted(wait);
  budget.spend();
  const started = Date.now();
  const res = await fetch(`${HOST}/api/projects/${PROJECT_ID}/query/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query }, name: `ocb-crm:${name}` }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 429) {
    const ra = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    throw new RateLimited(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15 * 60_000);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`posthog ${res.status} on ${name}: ${body.slice(0, 300)}`);
  }
  const parsed = responseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error(`posthog: unexpected response shape on ${name}`);
  console.log(`[posthog] ${name}: ${parsed.data.results.length} rows in ${Date.now() - started} ms`);
  return parsed.data.results;
}

export const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const str = (v: unknown): string => (v == null ? "" : String(v));
