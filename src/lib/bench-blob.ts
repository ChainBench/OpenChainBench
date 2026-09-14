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

import type { Benchmark, BenchIndexEntry } from "@/types/benchmark";
import type { ProviderAppearance, ProviderProfile } from "@/lib/providers";
import {
  MAT_SCHEMA_VERSION,
  type MaterializedSnapshot,
} from "@/lib/materialize/schema";

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

async function fetchJson(url: string, revalidateSec = 300): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      next: { revalidate: revalidateSec },
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

/**
 * Snapshot-shaped adapter for callers that expect the exact
 * `readMaterialized` return value. Lets `readMaterialized(slug, sig)`
 * call sites become `loadSnapshotFromBlob(slug, sig) ?? readMaterialized(slug, sig)`
 * with zero downstream code change. `state` is stubbed empty because
 * the blob broadcast doesn't include ring-buffer state (worker-internal,
 * never read by the site — only the aggregation loop uses it).
 */
export async function loadSnapshotFromBlob(
  slug: string,
  sig: string,
): Promise<MaterializedSnapshot | null> {
  const url = sig
    ? `${baseUrl()}/variants/${encodeURIComponent(slug)}/${encodeURIComponent(sig)}.json`
    : `${baseUrl()}/benches/${encodeURIComponent(slug)}.json`;
  const raw = await fetchJson(url);
  if (!isBenchEnvelope(raw) || raw.v !== 1 || raw.slug !== slug) return null;
  if (sig) {
    const env = raw as VariantEnvelope;
    if (env.sig !== sig) return null;
  }
  return {
    v: MAT_SCHEMA_VERSION,
    slug,
    sig,
    builtAt: raw.builtAt,
    bench: raw.bench,
    state: { providers: {}, rings: {} },
  };
}

/**
 * Provider index published by the worker (`providers.json`).
 *
 * Wire format v2 is normalized: each bench descriptor appears once under
 * `benches` and every appearance references it by slug. The denormalized
 * profile list repeats the descriptor per provider and weighs ~2.1 MB,
 * above the Next data-cache ceiling; normalized it is ~1 MB, so the
 * fetch is cached like any other blob and the page stays static. Both
 * the worker (`toProvidersWire`) and this reader own the format.
 */
export type ProvidersWire = {
  v: 2;
  builtAt: number;
  benches: Record<string, ProviderAppearance["benchmark"]>;
  providers: Array<
    Omit<ProviderProfile, "appearances"> & {
      appearances: Array<Omit<ProviderAppearance, "benchmark"> & { b: string }>;
    }
  >;
};

export function toProvidersWire(
  providers: ProviderProfile[],
  builtAt: number,
): ProvidersWire {
  const benches: ProvidersWire["benches"] = {};
  const compact = providers.map((p) => ({
    ...p,
    appearances: p.appearances.map((a) => {
      benches[a.benchmark.slug] ??= a.benchmark;
      const { benchmark, ...rest } = a;
      return { b: benchmark.slug, ...rest };
    }),
  }));
  return { v: 2, builtAt, benches, providers: compact };
}

export function fromProvidersWire(wire: ProvidersWire): ProviderProfile[] {
  return wire.providers.map((p) => ({
    ...p,
    appearances: p.appearances
      .map(({ b, ...rest }) => {
        const benchmark = wire.benches[b];
        return benchmark ? { ...rest, benchmark } : null;
      })
      .filter((a): a is ProviderAppearance => a !== null),
  }));
}

/** Returns null when the worker has not published the index yet (older
 *  worker build) or the envelope is not v2; the site then builds the
 *  index itself from the aggregate. */
export async function loadProvidersFromBlob(): Promise<ProviderProfile[] | null> {
  const raw = (await fetchJson(`${baseUrl()}/providers.json`, 900)) as Partial<ProvidersWire> | null;
  if (!raw || raw.v !== 2 || typeof raw.benches !== "object" || !Array.isArray(raw.providers)) {
    return null;
  }
  return fromProvidersWire(raw as ProvidersWire);
}

/**
 * Light bench index published by the worker (`index.json`): one small
 * row per bench, enough for navigation surfaces (related benches,
 * category rails) that used to load the full 8 MB aggregate for a
 * handful of titles. Cached through the data cache: it is ~100 KB.
 */
export async function loadBenchIndexFromBlob(): Promise<BenchIndexEntry[] | null> {
  const raw = (await fetchJson(`${baseUrl()}/index.json`)) as
    | { v?: number; benches?: unknown }
    | null;
  if (!raw || raw.v !== 1 || !Array.isArray(raw.benches)) return null;
  return raw.benches as BenchIndexEntry[];
}
