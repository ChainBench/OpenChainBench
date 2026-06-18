/**
 * Per-pair cache for `/compare/[slug]` pages.
 *
 * Why this exists: a fresh ad hoc pair like `coinpaprika-vs-mobula` is
 * not in `generateStaticParams`, so the first visitor pays the full fan
 * out cost. `buildSharedBenches` loads the unfiltered bench, every
 * declared chain variant, every declared region variant, and every
 * (chain, region) tuple for benches that expose both dims. On a five
 * shared bench pair that adds up to roughly 100 `loadBenchmark` round
 * trips, most of which hit Prometheus directly because the filtered
 * variants don't currently check KV first. Result: 3 to 5 seconds of
 * perceived latency on the cold render.
 *
 * This module caches the computed `SharedBench[]` per canonical pair
 * slug. The cold visitor still pays the cost, but everyone after gets a
 * single Upstash read instead of the full fan out.
 *
 * Auto invalidation: every cached envelope carries an `inputsHash` that
 * mixes the provider slugs, the sorted shared bench list, and the
 * deploy SHA. The reader recomputes it from the live inputs and ignores
 * any cache entry whose hash doesn't match. So:
 *   - A new bench enters the shared set => hash changes => rebuild.
 *   - A provider gains or loses an appearance => hash changes => rebuild.
 *   - A new deploy ships => SHA changes => every entry invalidated, all
 *     compare pages re-cache on first visit after deploy.
 *   - YAML edit between deploys is bounded by the 15 minute TTL.
 *
 * Safety:
 *   - Reads time out at 2 s and return null on any failure path. The
 *     caller falls through to `buildSharedBenches` exactly like the
 *     uncached behaviour.
 *   - Writes are fire and forget via `after()` so they never block the
 *     response and never throw.
 *   - When KV env vars are unset (local dev) or `OCB_COMPARE_CACHE_ENABLED=false`,
 *     every function in here is a silent no op.
 *   - Zod validates the envelope shape; shape drift across deploys is
 *     swallowed and treated as a miss.
 */

import { after } from "next/server";
import { z } from "zod";

const KEY_PREFIX = "ocb:cmp:v1:";

/** Bumped when the SharedBench shape changes so old envelopes are
 *  ignored on the very first read after a shape-changing deploy. The
 *  inputsHash already provides per-input invalidation; this is the
 *  schema-shape escape hatch. */
const SCHEMA_VERSION = 1 as const;

/** TTL chosen relative to the underlying bench freshness: each bench
 *  page revalidates every 60 s, so a 15 min compare cache lags by at
 *  most ~15x the bench ISR window. Acceptable trade off for ad hoc
 *  pairs that aren't editorial canon. */
const TTL_SECONDS = 15 * 60;

const PanelSchema = z.object({
  rank: z.number(),
  p50: z.number(),
  p99: z.number(),
  sampleSize: z.number().optional(),
});

const BreakdownRowSchema = z.object({
  value: z.string(),
  label: z.string(),
  aP50: z.number(),
  bP50: z.number(),
  aWins: z.boolean(),
  bWins: z.boolean(),
});

const ChainRegionEntrySchema = BreakdownRowSchema.extend({
  regionRows: z.array(BreakdownRowSchema),
});

const SharedBenchSchema = z.object({
  slug: z.string(),
  title: z.string(),
  category: z.string(),
  unit: z.string(),
  metric: z.string(),
  higherIsBetter: z.boolean(),
  lastRunAt: z.string().nullable().optional(),
  aResult: PanelSchema,
  bResult: PanelSchema,
  aggregateWinner: z.enum(["a", "b", "tie"]),
  chainBreakdown: z.array(BreakdownRowSchema),
  regionBreakdown: z.array(BreakdownRowSchema),
  chainRegionMatrix: z.array(ChainRegionEntrySchema),
});

const EnvelopeSchema = z.object({
  _v: z.literal(SCHEMA_VERSION),
  savedAt: z.number().int().positive(),
  inputsHash: z.string(),
  shared: z.array(SharedBenchSchema),
});

function isEnabled(): boolean {
  if (process.env.OCB_COMPARE_CACHE_ENABLED === "false") return false;
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

/** Stable hash of every input that determines the cached SharedBench[]
 *  content. If any input changes between writer and reader, the reader
 *  ignores the cache and the caller rebuilds. Mixing the deploy SHA in
 *  guarantees every deploy invalidates all entries even when the
 *  per-pair inputs are unchanged. */
export function computeInputsHash(parts: {
  providerA: string;
  providerB: string;
  benchSlugs: string[];
}): string {
  const sortedBenches = [...parts.benchSlugs].sort();
  const deploy =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
    "local";
  const seed = `${deploy}|${parts.providerA}|${parts.providerB}|${sortedBenches.join(",")}`;
  // FNV-1a 32 bit, plenty for cache busting (no security property needed).
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Read the cached `SharedBench[]` for a pair. Returns null on miss,
 *  KV unreachable, shape drift, or inputs mismatch. The caller MUST fall
 *  through to the real builder on null and never surface an error. */
export async function readPairCache<T>(
  pairSlug: string,
  expectedInputsHash: string,
): Promise<T[] | null> {
  if (!isEnabled()) {
    console.warn(`[CMP-CACHE] read skip pair=${pairSlug} reason=disabled`);
    return null;
  }
  const t0 = Date.now();
  try {
    const res = await fetch(
      `${kvUrl()}/get/${encodeURIComponent(KEY_PREFIX + pairSlug)}`,
      {
        method: "GET",
        headers: authHeader(),
        cache: "no-store",
        signal: AbortSignal.timeout(2_000),
      },
    );
    const ms = Date.now() - t0;
    if (!res.ok) {
      console.warn(
        `[CMP-CACHE] read fail pair=${pairSlug} status=${res.status} ms=${ms}`,
      );
      return null;
    }
    const env = (await res.json()) as { result?: string | null };
    if (!env.result) {
      console.warn(`[CMP-CACHE] read miss pair=${pairSlug} ms=${ms} (no entry)`);
      return null;
    }
    const raw = JSON.parse(env.result);
    const parsed = EnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(
        `[CMP-CACHE] read miss pair=${pairSlug} ms=${ms} reason=shape_drift`,
      );
      return null;
    }
    if (parsed.data.inputsHash !== expectedInputsHash) {
      console.warn(
        `[CMP-CACHE] read miss pair=${pairSlug} ms=${ms} reason=hash_mismatch stored=${parsed.data.inputsHash} expected=${expectedInputsHash}`,
      );
      return null;
    }
    console.warn(
      `[CMP-CACHE] read HIT pair=${pairSlug} ms=${ms} entries=${parsed.data.shared.length}`,
    );
    return parsed.data.shared as T[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[CMP-CACHE] read err pair=${pairSlug} ms=${Date.now() - t0} err=${msg}`,
    );
    return null;
  }
}

/** Best effort write. Never throws, never blocks the response. */
export function writePairCache(
  pairSlug: string,
  inputsHash: string,
  shared: unknown[],
): void {
  if (!isEnabled()) {
    console.warn(`[CMP-CACHE] write skip pair=${pairSlug} reason=disabled`);
    return;
  }
  const work = (async () => {
    const t0 = Date.now();
    try {
      const body = JSON.stringify({
        _v: SCHEMA_VERSION,
        savedAt: Date.now(),
        inputsHash,
        shared,
      });
      const bodyBytes = body.length;
      // Upstash REST: POST /set/{key}?EX={seconds} writes with TTL.
      const res = await fetch(
        `${kvUrl()}/set/${encodeURIComponent(
          KEY_PREFIX + pairSlug,
        )}?EX=${TTL_SECONDS}`,
        {
          method: "POST",
          headers: { ...authHeader(), "Content-Type": "application/json" },
          body,
          cache: "no-store",
        },
      );
      const ms = Date.now() - t0;
      if (res.ok) {
        console.warn(
          `[CMP-CACHE] write OK pair=${pairSlug} ms=${ms} bytes=${bodyBytes} entries=${shared.length}`,
        );
      } else {
        console.warn(
          `[CMP-CACHE] write fail pair=${pairSlug} ms=${ms} status=${res.status} bytes=${bodyBytes}`,
        );
      }
    } catch (err) {
      console.warn(
        `[CMP-CACHE] write err pair=${pairSlug} ms=${Date.now() - t0} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  })();
  try {
    after(work);
  } catch {
    void work;
  }
}
