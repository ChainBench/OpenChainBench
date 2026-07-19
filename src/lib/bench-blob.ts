/**
 * Per-bench + per-variant CDN reader (Phase 3 of the SRH-elimination).
 *
 * The materialize worker publishes:
 *   - `bench-aggregate/latest.json`         (all benches, homepage)
 *   - `bench-aggregate/benches/<slug>.json` (one unfiltered bench)
 *   - `bench-aggregate/variants/<slug>/<sig>.json` (one filtered variant)
 *
 * Aggregate is consumed by `src/lib/aggregate-blob.ts` (Phase 2). This
 * module handles the two per-bench shapes — replaces the SRH GETs that
 * `loadBenchmarkUnfilteredCached` and `loadBenchmarkFiltered` used to
 * make in `src/lib/spec.ts`.
 *
 * Failure model: any error (fetch throw, 4xx/5xx, malformed JSON, schema
 * mismatch) resolves to `null` so callers fall through to the Redis
 * path. Never throws.
 */

import type { Benchmark } from "@/types/benchmark";

const DEFAULT_BASE_URL = "https://kv.openchainbench.com/aggregate";
const FETCH_TIMEOUT_MS = 5_000;

type BenchEnvelope = {
  v: number;
  builtAt: number;
  slug: string;
  bench: Benchmark;
};

type VariantEnvelope = BenchEnvelope & { sig: string };

function baseUrl(): string {
  return process.env.AGGREGATE_BLOB_BASE_URL || DEFAULT_BASE_URL;
}

function isBenchEnvelope(x: unknown): x is BenchEnvelope {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.v === "number" &&
    typeof o.builtAt === "number" &&
    typeof o.slug === "string" &&
    typeof o.bench === "object" &&
    o.bench !== null
  );
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch a single unfiltered bench from the CDN. Returns the raw
 * `Benchmark` from the store (no editorial overlay applied — caller
 * layers that on top so a stale blob doesn't outlive a spec edit).
 */
export async function loadBenchFromBlob(
  slug: string,
): Promise<Benchmark | null> {
  const url = `${baseUrl()}/benches/${encodeURIComponent(slug)}.json`;
  const raw = await fetchJson(url);
  if (!isBenchEnvelope(raw) || raw.v !== 1 || raw.slug !== slug) return null;
  return raw.bench;
}

/**
 * Fetch a single filtered variant from the CDN. `sig` is the filterSig
 * string (empty for unfiltered — callers with sig="" should use
 * `loadBenchFromBlob` instead).
 */
export async function loadVariantFromBlob(
  slug: string,
  sig: string,
): Promise<Benchmark | null> {
  if (!sig) return null;
  const url = `${baseUrl()}/variants/${encodeURIComponent(slug)}/${encodeURIComponent(sig)}.json`;
  const raw = await fetchJson(url);
  if (!isBenchEnvelope(raw) || raw.v !== 1 || raw.slug !== slug) return null;
  const env = raw as VariantEnvelope;
  if (env.sig !== sig) return null;
  return env.bench;
}
