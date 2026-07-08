/**
 * Server-side helper for the /rpc hub page. Aggregates every per-chain
 * RPC bench (spec slug ending in `-rpc`, currently 044-053) into one
 * cross-chain snapshot: best provider per chain, best provider per
 * probe region, the full provider field per chain, and a provider
 * pivot (which provider covers which chains, at what rank).
 *
 * Blob-only era: the builder reads ONLY the worker-published bench
 * blobs from the materialize store (`ocb:mat:v1:<slug>:<sig>:current`),
 * never Prometheus. The materialize worker calls the builder after its
 * tier sweeps and parks the result under the `ocb:cohort:rpc-hub:v1`
 * envelope; the page reads that envelope first and, on a miss, rebuilds
 * from the same bench blobs (still zero Prom traffic) so the hub works
 * even before the worker's next deploy.
 *
 * The chain list is derived from the spec directory (every slug ending
 * `-rpc`), so adding an eleventh chain bench lights up here with no
 * code change.
 */

import { unstable_cache } from "next/cache";
import {
  cohortSnapshotConfigured,
  readCohortSnapshot,
  writeCohortSnapshot,
} from "@/lib/cohort-snapshot";
import {
  filterSig,
  loadSpecsUncached,
} from "@/lib/materialize/load";
import { REMOVED_BENCH_SLUGS } from "@/lib/removed-benches";
import { readMaterialized, storeConfigured } from "@/lib/materialize/store";
import { chainLabelForSlug } from "@/lib/chains";
import type { Benchmark, ProviderResult } from "@/types/benchmark";
import type { Spec } from "@/lib/spec-schema";

export type RpcRegionKey = "us-east" | "eu-west" | "sgp";

export const RPC_REGION_KEYS: readonly RpcRegionKey[] = [
  "us-east",
  "eu-west",
  "sgp",
] as const;

export type RpcRegionBest = {
  provider: string;
  providerName: string;
  p50Ms: number;
};

export type RpcHubProvider = {
  provider: string;
  name: string;
  p50Ms: number;
  p99Ms?: number;
  successPct?: number;
  sampleSize?: number;
  /** p50 per probe region, keyed by region value. */
  regions: Partial<Record<RpcRegionKey, number>>;
};

export type RpcHubUnresponsiveProvider = {
  provider: string;
  name: string;
  /** Success rate over 24h (%, 2 decimals). Call counters keep
   *  recording through an outage, so this stays meaningful. */
  successPct?: number;
  sampleSize?: number;
};

export type RpcHubChain = {
  /** Chain slug, e.g. "ethereum". */
  chain: string;
  /** Bench slug, e.g. "ethereum-rpc". */
  slug: string;
  /** Chain display label from the chain registry ("Ethereum"). */
  name: string;
  /** Bench display title (spec.title). */
  benchTitle: string;
  providerCount: number;
  /** Cohort providers currently flagged unresponsive on this chain
   *  (probed, all calls failing, no latency). Never part of
   *  best/fastest computations — display-only context. */
  unresponsiveCount?: number;
  /** The unresponsive rows themselves (never ranked). Additive optional
   *  field: old blobs without it still parse. */
  unresponsive?: RpcHubUnresponsiveProvider[];
  best: RpcRegionBest | null;
  /** Best provider per probe region. */
  regions: Partial<Record<RpcRegionKey, RpcRegionBest>>;
  /** Full live provider field, sorted fastest first. */
  providers: RpcHubProvider[];
  /** Leader's 24h latency series, downsampled to <=48 points. */
  series?: number[];
  dataConfidence?: string;
  updatedAt: string;
};

export type RpcHubPivotRow = {
  provider: string;
  name: string;
  chainsCovered: number;
  medianRank: number;
  medianP50Ms: number;
  /** Median 24h success rate across covered chains (%, 2 decimals).
   *  Optional: absent from older blobs and success-less rows. */
  medianSuccessPct?: number;
  /** Failed probes over 24h summed across covered chains:
   *  Σ round(sampleSize × (1 − successPct/100)). Optional (needs
   *  sampleSize; absent from older blobs). */
  errors24h?: number;
  chains: Record<
    string,
    { p50Ms: number; rank: number; successPct?: number; sampleSize?: number }
  >;
};

export type RpcHubSnapshot = {
  chains: RpcHubChain[];
  providersPivot: RpcHubPivotRow[];
  totals: { chains: number; uniqueProviders: number; regions: number };
  generatedAt: string;
};

/** Upstash key for the rpc-hub cohort blob, written by the materialize
 *  worker after every tier sweep. The cohort-snapshot module appends
 *  its own `:v1`. */
const RPC_HUB_KEY = "rpc-hub";

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Cap a series at `max` points so 10 chains of sparklines cannot bloat
 *  the cohort blob (Upstash + unstable_cache 2 MB ceilings). */
function downsample(series: number[], max = 48): number[] {
  if (series.length <= max) return series.map(round1);
  const out: number[] = [];
  for (let i = 0; i < max; i++) {
    out.push(round1(series[Math.floor((i * series.length) / max)]));
  }
  return out;
}

/** The unfiltered blob's extras.regions uses the harness's RegionPoint
 *  keys ("ap-southeast" for the Singapore probe); the spec's region
 *  dimension uses "sgp". Normalize onto the dimension values. */
function toRegionKey(raw: string): RpcRegionKey | null {
  if (raw === "ap-southeast" || raw === "sgp") return "sgp";
  if (raw === "us-east" || raw === "eu-west") return raw;
  return null;
}

/** Live rows only: augmentation marks dead providers `unavailable` with
 *  zeroed aggregates; those must never rank on the hub. */
function liveRows(bench: Benchmark): ProviderResult[] {
  return bench.results
    .filter(
      (r) =>
        r.availability !== "unavailable" &&
        Number.isFinite(r.ms.p50) &&
        r.ms.p50 > 0,
    )
    .sort((a, b) => a.ms.p50 - b.ms.p50);
}

async function buildChain(spec: Spec): Promise<RpcHubChain | null> {
  const snap = await readMaterialized(spec.slug, "");
  if (!snap) return null;
  const bench = snap.bench;
  const rows = liveRows(bench);
  if (rows.length === 0) return null;

  // Per-provider per-region p50. Primary source: the unfiltered blob's
  // extras.regions (refreshed every tier-A sweep). Gap-fill from the
  // tier-B region variant blobs (sig "region=<r>"), whose headline p50
  // is the region-scoped aggregate for each provider.
  const regionP50: Record<string, Partial<Record<RpcRegionKey, number>>> = {};
  for (const r of rows) {
    const points = bench.extras.regions?.[r.slug] ?? [];
    for (const pt of points) {
      const key = toRegionKey(pt.region);
      if (!key || !Number.isFinite(pt.p50) || pt.p50 <= 0) continue;
      (regionP50[r.slug] ??= {})[key] = round1(pt.p50);
    }
  }
  const variantSnaps = await Promise.all(
    RPC_REGION_KEYS.map((region) =>
      readMaterialized(spec.slug, filterSig({ region })).catch(() => null),
    ),
  );
  for (let i = 0; i < RPC_REGION_KEYS.length; i++) {
    const region = RPC_REGION_KEYS[i];
    const vsnap = variantSnaps[i];
    if (!vsnap) continue;
    for (const r of liveRows(vsnap.bench)) {
      const bucket = (regionP50[r.slug] ??= {});
      if (bucket[region] == null) bucket[region] = round1(r.ms.p50);
    }
  }

  // Best per region across the live field.
  const regions: Partial<Record<RpcRegionKey, RpcRegionBest>> = {};
  for (const region of RPC_REGION_KEYS) {
    let best: RpcRegionBest | null = null;
    for (const r of rows) {
      const v = regionP50[r.slug]?.[region];
      if (v == null) continue;
      if (!best || v < best.p50Ms) {
        best = { provider: r.slug, providerName: r.name, p50Ms: v };
      }
    }
    if (best) regions[region] = best;
  }

  const leader = rows[0];
  const chain = spec.slug.replace(/-rpc$/, "");
  const leaderSeries = bench.extras.series24h?.[leader.slug];
  // Unresponsive rows are excluded from `rows` by liveRows (they carry
  // availability="unavailable" and zero latency), so they can't touch
  // best/fastest — surface count + identity/success for display-only
  // consumers (chains table, product pages).
  const unresponsiveRows = bench.results.filter((r) => r.unresponsive);

  return {
    chain,
    slug: spec.slug,
    name: chainLabelForSlug(chain) ?? chain,
    benchTitle: spec.title,
    providerCount: rows.length,
    ...(unresponsiveRows.length > 0
      ? {
          unresponsiveCount: unresponsiveRows.length,
          unresponsive: unresponsiveRows.map((r) => ({
            provider: r.slug,
            name: r.name,
            ...(Number.isFinite(r.successRate)
              ? { successPct: round2(r.successRate) }
              : {}),
            ...(r.sampleSize != null
              ? { sampleSize: Math.round(r.sampleSize) }
              : {}),
          })),
        }
      : {}),
    best: { provider: leader.slug, providerName: leader.name, p50Ms: round1(leader.ms.p50) },
    regions,
    providers: rows.map((r) => ({
      provider: r.slug,
      name: r.name,
      p50Ms: round1(r.ms.p50),
      p99Ms: Number.isFinite(r.ms.p99) && r.ms.p99 > 0 ? round1(r.ms.p99) : undefined,
      successPct:
        Number.isFinite(r.successRate) && r.successRate > 0
          ? round2(r.successRate)
          : undefined,
      sampleSize: r.sampleSize != null ? Math.round(r.sampleSize) : undefined,
      regions: regionP50[r.slug] ?? {},
    })),
    series:
      leaderSeries && leaderSeries.length > 1
        ? downsample(leaderSeries)
        : undefined,
    dataConfidence: bench.dataConfidence,
    updatedAt: new Date(bench.dataAsOf ?? snap.builtAt).toISOString(),
  };
}

function buildPivot(chains: RpcHubChain[]): RpcHubPivotRow[] {
  const acc = new Map<
    string,
    { name: string; chains: RpcHubPivotRow["chains"] }
  >();
  for (const c of chains) {
    c.providers.forEach((p, i) => {
      const entry =
        acc.get(p.provider) ?? { name: p.name, chains: {} };
      entry.chains[c.chain] = {
        p50Ms: p.p50Ms,
        rank: i + 1,
        ...(p.successPct != null ? { successPct: p.successPct } : {}),
        ...(p.sampleSize != null ? { sampleSize: p.sampleSize } : {}),
      };
      acc.set(p.provider, entry);
    });
  }
  const rows: RpcHubPivotRow[] = [...acc.entries()].map(
    ([provider, { name, chains: perChain }]) => {
      const cells = Object.values(perChain);
      // Reliability aggregates over covered chains only. Success is a
      // median (robust to one bad chain); errors are an absolute sum of
      // failed probes, same derivation as the ledger's Errors column.
      const successes = cells
        .map((c) => c.successPct)
        .filter((v): v is number => v != null);
      const errorCells = cells.filter(
        (c) => c.sampleSize != null && c.successPct != null,
      );
      const errors24h = errorCells.reduce(
        (sum, c) =>
          sum + Math.round((c.sampleSize as number) * (1 - (c.successPct as number) / 100)),
        0,
      );
      return {
        provider,
        name,
        chainsCovered: cells.length,
        medianRank: round1(median(cells.map((c) => c.rank))),
        medianP50Ms: round1(median(cells.map((c) => c.p50Ms))),
        ...(successes.length > 0
          ? { medianSuccessPct: round2(median(successes)) }
          : {}),
        ...(errorCells.length > 0 ? { errors24h } : {}),
        chains: perChain,
      };
    },
  );
  // Coverage first (the pivot's whole point), then rank quality.
  return rows.sort(
    (a, b) =>
      b.chainsCovered - a.chainsCovered ||
      a.medianRank - b.medianRank ||
      a.medianP50Ms - b.medianP50Ms,
  );
}

/**
 * Build the rpc-hub snapshot from the worker-published bench blobs.
 * Store reads only, zero Prom queries — safe to call from both the
 * worker (cohort writer) and, as a cold-start fallback, from Vercel.
 * Returns null when the store is unconfigured or no `-rpc` bench blob
 * resolves (worker not yet sweeping the cluster).
 */
export async function buildRpcHubSnapshotFresh(): Promise<RpcHubSnapshot | null> {
  if (!storeConfigured()) return null;
  const specs = await loadSpecsUncached();
  const rpcSpecs = specs
    .filter((s) => s.slug.endsWith("-rpc"))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (rpcSpecs.length === 0) return null;

  const settled = await Promise.allSettled(rpcSpecs.map(buildChain));
  const chains: RpcHubChain[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled" && r.value) chains.push(r.value);
    else if (r.status === "rejected") {
      console.warn(
        `rpc-hub: ${rpcSpecs[i].slug} failed: ${
          r.reason instanceof Error ? r.reason.message : r.reason
        }`,
      );
    }
  }
  if (chains.length === 0) return null;

  chains.sort((a, b) => a.name.localeCompare(b.name));
  const providersPivot = buildPivot(chains);

  return {
    chains,
    providersPivot,
    totals: {
      chains: chains.length,
      uniqueProviders: providersPivot.length,
      regions: RPC_REGION_KEYS.length,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Snapshot-first reader for the /rpc hub. Cohort blob (worker-written)
 * → rebuild from bench blobs + writeback → null. Both paths are
 * KV-only; the Vercel side never touches Prometheus. Null means the
 * page renders its "warming up" empty state.
 */
/** Prod-only gate on the worker-written snapshot. The worker builds the
 *  cohort blob from the FULL spec set (it runs outside Vercel, no
 *  VERCEL_ENV), so staging-pipeline chains like monad-rpc reach the
 *  shared KV; drop them at read time and recompute the pivot + totals
 *  so provider aggregates only span the chains actually shown. */
function gateSnapshotForProd(snap: RpcHubSnapshot): RpcHubSnapshot {
  if (process.env.VERCEL_ENV !== "production") return snap;
  const chains = snap.chains.filter((c) => !REMOVED_BENCH_SLUGS.has(c.slug));
  if (chains.length === snap.chains.length) return snap;
  const providersPivot = buildPivot(chains);
  return {
    ...snap,
    chains,
    providersPivot,
    totals: {
      ...snap.totals,
      chains: chains.length,
      uniqueProviders: providersPivot.length,
    },
  };
}

async function fetchRpcHubRaw(): Promise<RpcHubSnapshot | null> {
  const snapshot = await readCohortSnapshot<RpcHubSnapshot>(RPC_HUB_KEY);
  if (snapshot) return gateSnapshotForProd(snapshot.data);
  const fresh = await buildRpcHubSnapshotFresh().catch(() => null);
  // No writeback on production: fresh is built from the prod-gated spec
  // set there, and the KV blob is shared with staging (worker + preview
  // deployments own its full-set content).
  if (
    fresh &&
    cohortSnapshotConfigured() &&
    process.env.VERCEL_ENV !== "production"
  ) {
    try {
      await writeCohortSnapshot(RPC_HUB_KEY, fresh);
    } catch (err) {
      console.warn(
        `rpc-hub writeback failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return fresh;
}

const fetchRpcHubCached = unstable_cache(
  fetchRpcHubRaw,
  // v4: prod-only gate drops staging-pipeline chains from the shared
  // worker blob at read time; env in key since the set differs per env.
  // v3: pivot rows gained medianSuccessPct/errors24h + per-chain
  // successPct/sampleSize; chains gained unresponsive[] rows.
  // v2: chains gained unresponsiveCount (unresponsive provider rows).
  ["rpc-hub-cohort-v4", process.env.VERCEL_ENV === "production" ? "prod" : "all"],
  { revalidate: 60, tags: ["rpc-cohort"] },
);

export async function fetchRpcHub(): Promise<RpcHubSnapshot | null> {
  return fetchRpcHubCached();
}
