/**
 * CDN-cached aggregate reader (Phase 2 of the SRH-elimination roadmap).
 *
 * The materialize worker publishes `{ v, builtAt, benches[] }` to
 * `https://kv.openchainbench.com/aggregate/latest.json` after every
 * Tier A sweep (see worker/publish-aggregate.ts). This module fetches
 * that URL from Vercel Fluid Compute, applies the current-spec editorial
 * overlay + slim projection, and returns a `Benchmark[]` that is
 * drop-in compatible with what `loadAllBenchmarksCached` produces.
 *
 * The whole point: one HTTP fetch (~1.5 MB gzipped, CDN-cached, ~20 ms
 * cold from edge) replaces the ~150 concurrent SRH GETs that the
 * per-bench aggregator used to fan out on every homepage revalidate.
 * That fan-out was the root cause of the "Awaiting samples" bursts
 * whenever SRH's connection pool went sideways.
 *
 * Failure model: network errors (fetch throw, 4xx/5xx) are re-thrown so
 * unstable_cache does not cache the failure and lets the next caller retry
 * against a fresh Vercel function instance. Data errors (malformed JSON,
 * schema mismatch, quorum check) return null so the caller can fall through
 * to the legacy Redis path.
 */

import { unstable_cache } from "next/cache";
import type { Benchmark } from "@/types/benchmark";
import { loadSpecsUncached } from "@/lib/materialize/load";
import { overlayEditorial, slimBenchmarkForCache } from "@/lib/spec";

// On any Vercel deployment (production or preview), use the self-hosted
// CDN proxy (/api/aggregate on openchainbench.com) so Vercel functions
// pay ~1 ms (edge cache hit) instead of ~12 s fetching the 7.5 MB blob
// directly from the Paris VPS across the Atlantic. The direct VPS path
// is only used for local dev where the CDN proxy may not be reachable.
const DEFAULT_URL =
  process.env.VERCEL_ENV
    ? "https://openchainbench.com/api/aggregate"
    : "https://kv.openchainbench.com/aggregate/latest.json";
const FETCH_TIMEOUT_MS = 20_000;
const MIN_BENCHES = 40;

type AggregateEnvelope = {
  v: number;
  builtAt: number;
  total?: number;
  liveCount?: number;
  draftCount?: number;
  benches: Benchmark[];
};

function isEnvelope(x: unknown): x is AggregateEnvelope {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.v === "number" &&
    typeof o.builtAt === "number" &&
    Array.isArray(o.benches)
  );
}

async function fetchAndProject(): Promise<Benchmark[] | null> {
  const url = process.env.AGGREGATE_BLOB_URL || DEFAULT_URL;
  let raw: unknown;
  // Throw (not return null) on network errors so unstable_cache does not
  // cache the failure for the full revalidate window. A cached null poisons
  // every loadAllBenchmarksSafe() call for 60 s, forcing them all onto the
  // slow Redis fan-out path until the window expires. Throwing causes
  // unstable_cache to skip caching and lets the next caller retry, which
  // will typically hit a different Vercel function instance that can reach
  // the upstream without issues.
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // Bypass Next's fetch memoization; the outer unstable_cache handles
      // cross-request caching, we don't want double-layered TTLs.
      cache: "no-store",
      // Explicitly request compression so Vercel's Node.js fetch gets the
      // 2MB gzip payload instead of the 7.5MB raw JSON.
      headers: { "Accept-Encoding": "gzip, br" },
    });
    if (!res.ok) {
      throw new Error(`[aggregate-blob] fetch ${url} → ${res.status}`);
    }
    raw = await res.json();
  } catch (err) {
    // Re-throw so unstable_cache does not cache this failure.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[aggregate-blob] fetch failed: ${msg}`);
    throw err;
  }
  if (!isEnvelope(raw) || raw.v !== 1) {
    console.warn("[aggregate-blob] envelope schema mismatch");
    return null;
  }
  if (raw.benches.length < MIN_BENCHES) {
    console.warn(
      `[aggregate-blob] rejecting suspiciously small envelope: ${raw.benches.length} < ${MIN_BENCHES}`,
    );
    return null;
  }

  // Apply the current-spec editorial overlay + slim projection so the
  // shape matches what `loadAllBenchmarksCached` produces. The worker
  // may have written a snapshot BEFORE a YAML edit rolled through, so
  // the overlay is what keeps chain renames + editorial edits + prov
  // rename reconciliation live without waiting for the worker sweep.
  const specs = await loadSpecsUncached();
  const specBySlug = new Map(specs.map((s) => [s.slug, s] as const));
  const projected: Benchmark[] = [];
  for (const bench of raw.benches) {
    const spec = specBySlug.get(bench.slug);
    if (!spec) continue; // Bench in blob no longer has a spec — skip.
    projected.push(slimBenchmarkForCache(overlayEditorial(bench, spec)));
  }
  return projected.sort((a, b) =>
    (a.number ?? "").localeCompare(b.number ?? ""),
  );
}

/**
 * Fetch the aggregate snapshot from the CDN and project it against the
 * current specs. Cross-request cached under the `bench-aggregate` tag
 * so `revalidateTag('bench-aggregate', 'default')` (called by the
 * worker's revalidate hook) purges instantly on new publish.
 *
 * Returns `null` on any failure so callers can fall back to Redis.
 */
export const loadAggregateFromBlob = unstable_cache(
  fetchAndProject,
  ["aggregate-blob-v2"],
  { revalidate: 60, tags: ["bench-aggregate", "benchmarks"] },
);
