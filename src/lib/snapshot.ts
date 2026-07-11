/**
 * Persistent snapshot layer for benchmark runtime data.
 *
 * Why this exists: the per-bench unstable_cache + throw-to-preserve
 * pattern handles transient Prom failures while a previous cache exists,
 * but on COLD START (new Vercel instance) during a Prom blackout there
 * is no previous cache to preserve. The user sees "AWAITING samples"
 * even though the bench has perfectly good data from 60 s ago.
 *
 * This module saves the runtime-derived parts of each Benchmark to KV
 * after every successful Prom fetch, and offers them back on the failure
 * path. Editorial metadata (title, abstract, faq, etc.) is rebuilt fresh
 * from the spec on every read so a deploy with edited YAML doesn't keep
 * surfacing stale copy.
 *
 * Storage: native fetch against the Upstash REST API. Vercel injects
 * KV_REST_API_URL + KV_REST_API_TOKEN automatically when a Redis store
 * is attached to the project via the marketplace integration. When the
 * env vars are not set (local dev with no KV configured, or production
 * before a KV store is provisioned), every function in here is a
 * silent no-op — the rest of the data layer behaves exactly as it did
 * before this module existed.
 *
 * Safety properties:
 *   - Writes are fire-and-forget; the caller never awaits them.
 *   - Failures are caught and logged at warn level; no caller path can
 *     break because KV is down.
 *   - Reads validate with Zod and discard anything that doesn't match
 *     the schema (defends against shape drift across deploys).
 *   - Snapshots older than MAX_SNAPSHOT_AGE_MS are refused; better to
 *     surface "AWAITING" than to lie about freshness over a long
 *     outage.
 */

import { after } from "next/server";
import { z } from "zod";
import type {
  Benchmark,
  CellRankEntry,
  MetricPanel,
  ProviderResult,
  ResultExtras,
} from "@/types/benchmark";

// Shared zod primitives that mirror the TS types in `@/types/benchmark`.
// Keep these in sync with that file; the `AssertEqual` lines at the
// bottom of this block force a compile error if the inferred zod type
// drifts from the canonical TS type.
const UnitSchema = z.enum([
  "ms",
  "s",
  "sec",
  "pct",
  "bps",
  "bp",
  "count",
  "slots",
  "usd",
  "gwei",
]);

const StalenessMetaSchema = z.object({
  observedAt: z.number(),
  staleSince: z.number().optional(),
});

const ProviderResultSchema = z.object({
  name: z.string(),
  slug: z.string(),
  tag: z.string().optional(),
  type: z.enum(["protocol", "aggregator", "intent", "relay"]).optional(),
  layer: z.enum(["l1", "l2"]).optional(),
  ms: z.object({
    p50: z.number(),
    p90: z.number(),
    p99: z.number(),
    mean: z.number(),
  }),
  slots: z.object({ p50: z.number(), p99: z.number() }).optional(),
  successRate: z.number(),
  sampleSize: z.number().optional(),
  dataConfidence: z.enum(["healthy", "low", "insufficient"]).optional(),
  sampleHealth: z.number().optional(),
  secondary: z.object({ label: z.string(), value: z.string() }).optional(),
  availability: z.enum(["live", "unavailable"]).optional(),
  meta: StalenessMetaSchema.optional(),
  query: z.string().optional(),
  formula: z.string().optional(),
});

const RegionPointSchema = z.object({
  region: z.enum(["us-east", "eu-west", "ap-southeast", "global"]),
  p50: z.number(),
});

const Series24hSchema = z.array(z.number());

const ResultExtrasSchema = z.object({
  series24h: z.record(z.string(), Series24hSchema),
  series7d: z.record(z.string(), Series24hSchema).optional(),
  series30d: z.record(z.string(), Series24hSchema).optional(),
  seriesByRegion24h: z
    .record(z.string(), z.record(z.string(), Series24hSchema))
    .optional(),
  seriesByRegion7d: z
    .record(z.string(), z.record(z.string(), Series24hSchema))
    .optional(),
  seriesByRegion30d: z
    .record(z.string(), z.record(z.string(), Series24hSchema))
    .optional(),
  regions: z.record(z.string(), z.array(RegionPointSchema)),
});

const MetricPanelSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  metric: z.string(),
  unit: UnitSchema,
  higherIsBetter: z.boolean(),
  tab: z.boolean().optional(),
  values: z.record(z.string(), z.number()),
  valuesMeta: z.record(z.string(), StalenessMetaSchema).optional(),
  seriesByProvider: z.record(z.string(), z.array(z.number())).optional(),
  seriesByProvider7d: z.record(z.string(), z.array(z.number())).optional(),
  seriesByProvider30d: z.record(z.string(), z.array(z.number())).optional(),
});

const CellRankEntrySchema = z.object({
  slug: z.string(),
  p50: z.number(),
});

// Compile-time guard rail: each inferred zod type must be assignable to
// the canonical TS type, and vice versa. Drift between this file and
// `@/types/benchmark` becomes a build error instead of a runtime parse
// failure. `AssertEqual` resolves to `true` when both directions hold.
type AssertEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _providerResultMatches: AssertEqual<
  z.infer<typeof ProviderResultSchema>,
  ProviderResult
> = true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _resultExtrasMatches: AssertEqual<
  z.infer<typeof ResultExtrasSchema>,
  ResultExtras
> = true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _metricPanelMatches: AssertEqual<
  z.infer<typeof MetricPanelSchema>,
  MetricPanel
> = true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _cellRankEntryMatches: AssertEqual<
  z.infer<typeof CellRankEntrySchema>,
  CellRankEntry
> = true;

/** Refuse snapshots older than this on read. 24 h matches the bench
 *  query window — a value older than that isn't meaningful as the
 *  "current" leaderboard, so a draft placeholder is more honest. */
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

const KEY_PREFIX = "ocb:snap:v1:";

/** Bump when changing the snapshot payload shape so deploys carrying a
 *  new field don't try to deserialize old-shape values. The Zod schema
 *  below would also reject those, but the version prefix lets us
 *  invalidate without writing strict-mode parsers. */
const SCHEMA_VERSION = 5 as const;

// Minimal runtime payload. Editorial metadata isn't snapshotted because
// it lives in YAML and is rebuilt from the spec on every read.
const SnapshotSchema = z.object({
  _v: z.literal(SCHEMA_VERSION),
  savedAt: z.number().int().positive(),
  lastRunAt: z.string(),
  sampleSize: z.number(),
  expectedN: z.number().optional(),
  dataConfidence: z.enum(["healthy", "low", "insufficient"]).optional(),
  results: z.array(ProviderResultSchema),
  extras: ResultExtrasSchema,
  bestPerChain: z.record(z.string(), ProviderResultSchema).optional(),
  worstPerChain: z.record(z.string(), ProviderResultSchema).optional(),
  providersPerChain: z.record(z.string(), z.array(z.string())).optional(),
  cellRanks: z.record(z.string(), z.array(CellRankEntrySchema)).optional(),
  metricPanels: z.array(MetricPanelSchema).optional(),
});

export type SnapshotPayload = {
  results: ProviderResult[];
  extras: ResultExtras;
  sampleSize: number;
  expectedN?: number;
  dataConfidence?: "healthy" | "low" | "insufficient";
  lastRunAt: string;
  bestPerChain?: Record<string, ProviderResult>;
  worstPerChain?: Record<string, ProviderResult>;
  providersPerChain?: Record<string, string[]>;
  cellRanks?: Record<string, CellRankEntry[]>;
  /** Panel values (series stripped to keep the KV value small). Without
   *  these a snapshot-served bench loses its chart view tabs and every
   *  panel-backed ledger column renders "-". */
  metricPanels?: MetricPanel[];
};

function isConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL?.trim() &&
      process.env.KV_REST_API_TOKEN?.trim(),
  );
}

function kvUrl(): string {
  return (process.env.KV_REST_API_URL ?? "").replace(/\/+$/, "");
}

function authHeader(): { Authorization: string } {
  return { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` };
}

/** A fresher snapshot with MORE providers wins over a new render with
 *  fewer. Window after which a bigger-but-aging snapshot stops blocking
 *  writes, so a legitimately shrunk provider field (YAML removal, a
 *  source dead for hours) can still refresh the snapshot. */
const SNAPSHOT_GUARD_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Best-effort save. Never throws, never blocks. Call without `await`
 * from inside a successful Prom path:
 *
 *   writeSnapshot(spec.slug, { results, extras, sampleSize, lastRunAt });
 *
 * Returns immediately; the work resolves in the background.
 *
 * Degradation guards (both motivated by Prom brownouts, where a cycle
 * can pass the 50% quorum yet still be worse than the snapshot it would
 * replace):
 *   - Coverage ratchet: if the existing snapshot is recent (< 2h) and
 *     has MORE providers than this render, skip the write entirely.
 *     Without this, repeated brownouts walk the snapshot down to the
 *     quorum floor and a cold start then serves the degraded board.
 *   - Stash carry-over: per-chain / per-cell stashes (bestPerChain,
 *     cellRanks, ...) are computed by separate Prom queries that can
 *     fail on an otherwise-healthy cycle. When the new render lacks one
 *     and the existing snapshot has it, carry the old value forward so
 *     scoped badges / placeholders don't 404 after a cold start.
 */
export function writeSnapshot(slug: string, payload: SnapshotPayload): void {
  if (!isConfigured()) return;
  const work = (async () => {
    try {
      const existing = await readSnapshotWithAge(slug);
      // KV unreachable (as opposed to "no snapshot yet"): skip the write
      // entirely. A degraded render slipping past the guards precisely
      // when the infra is under stress is the scenario the guards exist
      // for, and a healthy cycle lands 60s later anyway.
      if (existing === "error") {
        console.warn(`snapshot.write skipped for ${slug}: KV read failed`);
        return;
      }
      const merged: SnapshotPayload = { ...payload };
      if (existing) {
        // Compare actual live coverage, not array length: the rendered
        // bench pads `results` with an "unavailable" row for every
        // declared provider, so lengths are always equal by construction.
        const liveCount = (rs: ProviderResult[]) =>
          rs.filter((r) => r.availability !== "unavailable" && r.ms.p50 > 0)
            .length;
        const newLive = liveCount(payload.results);
        const oldLive = liveCount(existing.payload.results);
        if (existing.ageMs < SNAPSHOT_GUARD_WINDOW_MS && oldLive > newLive) {
          console.warn(
            `snapshot.write skipped for ${slug}: render has ${newLive} live providers, snapshot has ${oldLive}`,
          );
          return;
        }
        merged.bestPerChain ??= existing.payload.bestPerChain;
        merged.worstPerChain ??= existing.payload.worstPerChain;
        merged.providersPerChain ??= existing.payload.providersPerChain;
        merged.cellRanks ??= existing.payload.cellRanks;
        merged.metricPanels ??= existing.payload.metricPanels;
      }
      const body = JSON.stringify({
        _v: SCHEMA_VERSION,
        savedAt: Date.now(),
        ...merged,
      });
      // Upstash REST: POST /set/{key} with raw body = value.
      await fetch(`${kvUrl()}/set/${encodeURIComponent(KEY_PREFIX + slug)}`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body,
        cache: "no-store",
      });
    } catch (err) {
      console.warn(
        `snapshot.write failed for ${slug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  })();
  // Vercel can freeze the lambda as soon as the response is sent; an
  // unawaited promise then silently never completes. after() keeps the
  // function alive until the write lands. Falls back to fire-and-forget
  // outside a request scope (build-time prerender, tests).
  try {
    after(work);
  } catch {
    void work;
  }
}

/**
 * Read the last good snapshot for a slug. Returns null when:
 *   - KV is not configured (env vars missing)
 *   - no snapshot exists for the slug
 *   - the snapshot fails Zod validation (shape drift)
 *   - the snapshot is older than MAX_SNAPSHOT_AGE_MS
 *   - the network call fails or times out
 *
 * All errors are swallowed and logged at warn level so the caller can
 * fall through to its own draft/error path without surprises.
 */
export async function readSnapshot(
  slug: string,
): Promise<SnapshotPayload | null> {
  const hit = await readSnapshotWithAge(slug);
  return hit && hit !== "error" ? hit.payload : null;
}

/** Same as readSnapshot but exposes the snapshot's age. Used by the
 *  write-path degradation guards, which need to distinguish "no usable
 *  snapshot exists" (null → write proceeds) from "KV is unreachable"
 *  ("error" → write is skipped so a degraded render can't slip past the
 *  guards while the infra is down). */
async function readSnapshotWithAge(
  slug: string,
): Promise<{ payload: SnapshotPayload; ageMs: number } | null | "error"> {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(
      `${kvUrl()}/get/${encodeURIComponent(KEY_PREFIX + slug)}`,
      {
        method: "GET",
        headers: authHeader(),
        cache: "no-store",
        // Short timeout so a slow KV doesn't add latency on cold start
        // where every ms counts.
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (!res.ok) {
      console.warn(`[DRAFT-TRACE] kv_http slug=${slug} status=${res.status}`);
      return "error";
    }
    const env = (await res.json()) as { result?: string | null };
    if (!env.result) {
      console.warn(`[DRAFT-TRACE] kv_empty slug=${slug} (no snapshot ever written)`);
      return null;
    }
    const raw = JSON.parse(env.result);
    const parsed = SnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(
        `[DRAFT-TRACE] kv_shape slug=${slug} err=${parsed.error.message}`,
      );
      return null;
    }
    const age = Date.now() - parsed.data.savedAt;
    if (age > MAX_SNAPSHOT_AGE_MS) {
      console.warn(
        `[DRAFT-TRACE] kv_stale slug=${slug} age_min=${Math.round(age / 1000 / 60)}`,
      );
      return null;
    }
    return {
      ageMs: age,
      payload: {
        results: parsed.data.results,
        extras: parsed.data.extras,
        sampleSize: parsed.data.sampleSize,
        expectedN: parsed.data.expectedN,
        dataConfidence: parsed.data.dataConfidence,
        lastRunAt: parsed.data.lastRunAt,
        bestPerChain: parsed.data.bestPerChain,
        worstPerChain: parsed.data.worstPerChain,
        providersPerChain: parsed.data.providersPerChain,
        cellRanks: parsed.data.cellRanks,
        metricPanels: parsed.data.metricPanels,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish abort/timeout (most common) from other network errors so
    // the post-incident grep can see if it's KV slowness vs KV down.
    const tag = msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("timeout")
      ? "kv_timeout"
      : "kv_neterr";
    console.warn(`[DRAFT-TRACE] ${tag} slug=${slug} err=${msg}`);
    return "error";
  }
}

/** Helper for the spec loader: takes whatever we have in memory and
 *  rebuilds the snapshot-shaped subset of a Benchmark. Used so the
 *  caller doesn't have to repeat the field selection. */
export function snapshotFromBenchmark(b: Benchmark): SnapshotPayload {
  return {
    results: b.results,
    extras: b.extras,
    sampleSize: b.sampleSize,
    expectedN: b.expectedN,
    dataConfidence: b.dataConfidence,
    lastRunAt: b.lastRunAt,
    // Persist per-chain leader stash so the snapshot-recovery path
    // (loadBenchmarkUnfilteredCached's KV fallback in spec.ts) can
    // reconstruct a Benchmark that still resolves the
    // `{{best_name:chain:X}}` / `{{best_p50:chain:X}}` family of
    // placeholders. Without these, a cold-start fetched from the
    // snapshot serves the raw placeholder string to the page.
    bestPerChain: b.bestPerChain,
    worstPerChain: b.worstPerChain,
    providersPerChain: (b as { providersPerChain?: Record<string, string[]> })
      .providersPerChain,
    cellRanks: b.cellRanks,
    // Series stripped: 11 panels x 75 providers x 3 series would multiply
    // the KV value size; values + labels are what the tabs strip and the
    // panel-backed ledger columns need to survive a snapshot-served render.
    metricPanels: b.metricPanels?.map(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ({ seriesByProvider, seriesByProvider7d, seriesByProvider30d, ...rest }) =>
        rest,
    ),
  };
}
