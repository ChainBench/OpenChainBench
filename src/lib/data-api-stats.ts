/**
 * Server-side helper for the /data-api hub page. Loads bench blobs for
 * every "data API" benchmark (price feeds, token metadata, portfolio/wallet,
 * DEX coverage, NFT data) and assembles two views:
 *
 *   1. By Benchmark — groups benches by use-case, each bench has its leader,
 *      runners-up, per-region leaders (when the bench has region data), and
 *      per-chain leaders (when the bench has bestPerChain populated).
 *
 *   2. By Provider — cross-bench pivot: one row per unique provider, one cell
 *      per group, showing the provider's best rank + value in that group.
 *
 * Blob-only: reads from the CDN bench blobs published by the materialize
 * worker. Never touches Prometheus at render time. Graceful degradation:
 * missing/empty blobs render as null cells (never a throw).
 */

import { unstable_cache } from "next/cache";
import { loadBenchFromBlob } from "@/lib/bench-blob";
import type { Benchmark, ProviderResult } from "@/types/benchmark";

export type DataApiGroup =
  | "price-feeds"
  | "token-metadata"
  | "portfolio-wallet"
  | "dex-coverage"
  | "nft-data";

export const GROUP_ORDER: readonly DataApiGroup[] = [
  "price-feeds",
  "token-metadata",
  "portfolio-wallet",
  "dex-coverage",
  "nft-data",
];

export const GROUP_META: Record<
  DataApiGroup,
  { label: string; shortLabel: string; accent: string; description: string }
> = {
  "price-feeds": {
    label: "Price & Market Data",
    shortLabel: "Price Feeds",
    accent: "#f59e0b",
    description: "Real-time price feed latency from on-chain event to API emission.",
  },
  "token-metadata": {
    label: "Token Metadata",
    shortLabel: "Token Data",
    accent: "#8b5cf6",
    description: "Metadata coverage, asset registry depth, and quote routing capacity.",
  },
  "portfolio-wallet": {
    label: "Portfolio & Wallet",
    shortLabel: "Portfolio",
    accent: "#10b981",
    description: "Wallet indexing freshness, portfolio chain coverage, and label accuracy.",
  },
  "dex-coverage": {
    label: "DEX Coverage",
    shortLabel: "DEX",
    accent: "#0ea5e9",
    description: "Number of blockchains where each DEX indexer tracks pools and swap volumes.",
  },
  "nft-data": {
    label: "NFT Data",
    shortLabel: "NFT",
    accent: "#f43f5e",
    description: "Collection metadata field coverage across blue-chip NFT collections.",
  },
};

/** Each bench's group. Adding a bench to the hub = one line here. */
const BENCH_GROUP: Record<string, DataApiGroup> = {
  "aggregator-head-lag": "price-feeds",
  "metadata-coverage": "token-metadata",
  "asset-registry-coverage": "token-metadata",
  "token-quote-coverage": "token-metadata",
  "indexing-freshness": "portfolio-wallet",
  "portfolio-chain-coverage": "portfolio-wallet",
  "wallet-labels-coverage": "portfolio-wallet",
  "dex-network-coverage": "dex-coverage",
  "nft-collection-metadata": "nft-data",
};

const BENCH_SLUGS = Object.keys(BENCH_GROUP);

/** Short display titles for table rows (trimmed from the full spec title). */
const BENCH_SHORT_TITLE: Record<string, string> = {
  "aggregator-head-lag": "Price feed head lag",
  "metadata-coverage": "Token metadata coverage",
  "asset-registry-coverage": "Asset registry chains",
  "token-quote-coverage": "Token quote coverage",
  "indexing-freshness": "Wallet indexing freshness",
  "portfolio-chain-coverage": "Portfolio chain coverage",
  "wallet-labels-coverage": "Wallet label coverage",
  "dex-network-coverage": "DEX network coverage",
  "nft-collection-metadata": "NFT metadata coverage",
};

const CHAIN_LABELS: Record<string, string> = {
  base: "Base",
  bnb: "BNB",
  solana: "SOL",
  robinhood: "RH",
  ethereum: "ETH",
  xrp: "XRP",
  stellar: "XLM",
  ripple: "XRP",
  polygon: "POL",
  avalanche: "AVAX",
  arbitrum: "ARB",
  optimism: "OP",
  tron: "TRX",
  sui: "SUI",
  aptos: "APT",
  ton: "TON",
};

export type RegionLeader = {
  region: string;
  label: string;
  providerSlug: string;
  providerName: string;
  p50: number;
};

export type ChainLeader = {
  chain: string;
  label: string;
  providerSlug: string;
  providerName: string;
  p50: number;
};

export type DataApiBenchRow = {
  slug: string;
  number: string;
  title: string;
  shortTitle: string;
  metric: string;
  unit: Benchmark["unit"];
  higherIsBetter: boolean;
  leader: { slug: string; name: string; p50: number } | null;
  runners: { slug: string; name: string; p50: number }[];
  providerCount: number;
  regionLeaders: RegionLeader[];
  chainLeaders: ChainLeader[];
  updatedAt: string | null;
};

export type DataApiGroupRow = {
  group: DataApiGroup;
  benches: DataApiBenchRow[];
};

export type DataApiRegionScore = {
  region: string;
  label: string;
  rank: number;
  p50: number;
};

export type DataApiChainScore = {
  chain: string;
  label: string;
  p50: number;
};

/** Per-region chain wins: in this region, the provider is #1 on these chains. */
export type DataApiCellWin = {
  region: string;
  regionLabel: string;
  chains: { chain: string; label: string }[];
};

export type DataApiProviderCell = {
  benchSlug: string;
  benchShortTitle: string;
  group: DataApiGroup;
  rank: number;
  p50: number;
  unit: Benchmark["unit"];
  higherIsBetter: boolean;
  /** Per-region ranks for benches that have extras.regions but no cellRanks. */
  regions?: DataApiRegionScore[];
  /** Per-region chain wins from cellRanks (supersedes regions when present). */
  cellWins?: DataApiCellWin[];
};

export type DataApiProviderPivotRow = {
  slug: string;
  name: string;
  cells: DataApiProviderCell[];
  groups: Partial<
    Record<DataApiGroup, { bestRank: number; bestCell: DataApiProviderCell }>
  >;
  groupCount: number;
};

export type DataApiSnapshot = {
  groups: DataApiGroupRow[];
  providers: DataApiProviderPivotRow[];
  totals: {
    uniqueProviders: number;
    benchCount: number;
    groupCount: number;
    headlinePriceFeed: { name: string; value: string } | null;
    headlineIndexing: { name: string; value: string } | null;
  };
  generatedAt: string;
};

function liveResults(bench: Benchmark): ProviderResult[] {
  return bench.results.filter(
    (r) =>
      r.availability !== "unavailable" &&
      !r.unresponsive &&
      r.ms.p50 > 0 &&
      r.dataConfidence !== "insufficient",
  );
}

function sortedResults(
  results: ProviderResult[],
  higherIsBetter: boolean,
): ProviderResult[] {
  return [...results].sort((a, b) =>
    higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
  );
}

function computeRegionLeaders(bench: Benchmark): RegionLeader[] {
  const live = liveResults(bench);
  const { regions } = bench.extras;
  if (!regions || Object.keys(regions).length === 0) return [];

  const map = new Map<string, RegionLeader>();

  for (const provider of live) {
    const pts = regions[provider.slug] ?? [];
    for (const pt of pts) {
      if (pt.region === "global") continue;
      const normalized =
        pt.region === "ap-southeast" ? "sgp" : pt.region;
      const label =
        normalized === "sgp"
          ? "Singapore"
          : normalized === "us-east"
            ? "US East"
            : "EU West";

      const current = map.get(normalized);
      const isBetter = bench.higherIsBetter
        ? pt.p50 > (current?.p50 ?? -Infinity)
        : pt.p50 < (current?.p50 ?? Infinity);

      if (isBetter || !current) {
        map.set(normalized, {
          region: normalized,
          label,
          providerSlug: provider.slug,
          providerName: provider.name,
          p50: pt.p50,
        });
      }
    }
  }

  return (["us-east", "eu-west", "sgp"] as const)
    .filter((r) => map.has(r))
    .map((r) => map.get(r)!);
}

function computeChainLeaders(bench: Benchmark): ChainLeader[] {
  if (!bench.bestPerChain) return [];
  return Object.entries(bench.bestPerChain)
    .filter(([, r]) => r.availability !== "unavailable" && !r.unresponsive && r.ms.p50 > 0)
    .map(([chain, r]) => ({
      chain,
      label: CHAIN_LABELS[chain] ?? chain,
      providerSlug: r.slug,
      providerName: r.name,
      p50: r.ms.p50,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

const REGION_ORDER = ["us-east", "eu-west", "sgp"] as const;
const REGION_LABELS: Record<string, string> = {
  "us-east": "US",
  "eu-west": "EU",
  sgp: "SGP",
  "ap-southeast": "SGP",
};

/**
 * For each live provider in a bench, compute their rank per probe region.
 * Returns a map: providerSlug → sorted DataApiRegionScore[].
 * Empty map when bench has no extras.regions data.
 */
function computeProviderRegionScores(
  bench: Benchmark,
  live: ProviderResult[],
): Map<string, DataApiRegionScore[]> {
  const { regions } = bench.extras;
  if (!regions || Object.keys(regions).length === 0) return new Map();

  // Collect per-region p50 for all live providers
  const byRegion = new Map<string, { slug: string; p50: number }[]>();
  for (const provider of live) {
    const pts = regions[provider.slug] ?? [];
    for (const pt of pts) {
      if (pt.region === "global") continue;
      const norm = pt.region === "ap-southeast" ? "sgp" : pt.region;
      if (!byRegion.has(norm)) byRegion.set(norm, []);
      byRegion.get(norm)!.push({ slug: provider.slug, p50: pt.p50 });
    }
  }

  // Sort each region and assign ranks
  const result = new Map<string, DataApiRegionScore[]>();
  for (const [region, entries] of byRegion.entries()) {
    const sorted = [...entries].sort((a, b) =>
      bench.higherIsBetter ? b.p50 - a.p50 : a.p50 - b.p50,
    );
    for (const [idx, { slug, p50 }] of sorted.entries()) {
      if (!result.has(slug)) result.set(slug, []);
      result.get(slug)!.push({
        region,
        label: REGION_LABELS[region] ?? region.toUpperCase(),
        rank: idx + 1,
        p50,
      });
    }
  }

  // Sort each provider's scores in canonical region order
  for (const scores of result.values()) {
    scores.sort(
      (a, b) =>
        (REGION_ORDER as readonly string[]).indexOf(a.region) -
        (REGION_ORDER as readonly string[]).indexOf(b.region),
    );
  }

  return result;
}


function toBenchRow(slug: string, bench: Benchmark): DataApiBenchRow {
  const live = sortedResults(liveResults(bench), bench.higherIsBetter);
  return {
    slug,
    number: bench.number,
    title: bench.title,
    shortTitle: BENCH_SHORT_TITLE[slug] ?? bench.title,
    metric: bench.metric,
    unit: bench.unit,
    higherIsBetter: bench.higherIsBetter,
    leader: live[0]
      ? { slug: live[0].slug, name: live[0].name, p50: live[0].ms.p50 }
      : null,
    runners: live.slice(1, 4).map((r) => ({
      slug: r.slug,
      name: r.name,
      p50: r.ms.p50,
    })),
    providerCount: live.length,
    regionLeaders: computeRegionLeaders(bench),
    chainLeaders: computeChainLeaders(bench),
    updatedAt: bench.lastRunAt ?? null,
  };
}

export function fmtDataValue(v: number, unit: Benchmark["unit"]): string {
  if (!Number.isFinite(v)) return "...";
  switch (unit) {
    case "pct":
      return `${v.toFixed(1)}%`;
    case "count":
      return v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v));
    case "s": {
      // Convention: benches with unit "s" store ms in ms.p50 (see format.ts)
      const s = v / 1000;
      if (s >= 60) return `${(s / 60).toFixed(1)} min`;
      if (s < 1) return `${Math.round(v)} ms`;
      return `${s.toFixed(2)} s`;
    }
    case "sec": {
      // True seconds (indexing-freshness, etc.)
      if (v >= 60) return `${(v / 60).toFixed(1)} min`;
      return `${v.toFixed(1)} s`;
    }
    case "ms":
      if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
      return `${Math.round(v)} ms`;
    case "bps":
    case "bp":
      return `${v.toFixed(0)} bps`;
    default:
      return String(Math.round(v));
  }
}

/**
 * From bench.cellRanks (keys "chain|region"), extract the cells where
 * providerSlug is rank #1, grouped by region.
 * e.g. US → [BNB, Base], EU → [BNB], SGP → [SOL, RH]
 */
function computeProviderCellWins(
  bench: Benchmark,
  providerSlug: string,
): DataApiCellWin[] {
  if (!bench.cellRanks) return [];

  const regionChains = new Map<string, string[]>();
  for (const [key, entries] of Object.entries(bench.cellRanks)) {
    const [chain, region] = key.split("|");
    if (chain === "all" || region === "all") continue;
    if (entries[0]?.slug !== providerSlug) continue;
    const chains = regionChains.get(region) ?? [];
    chains.push(chain);
    regionChains.set(region, chains);
  }

  if (regionChains.size === 0) return [];

  return (["us-east", "eu-west", "ap-southeast", "sgp"] as const)
    .filter((r) => regionChains.has(r))
    .map((r) => ({
      region: r,
      regionLabel: REGION_LABELS[r] ?? r.toUpperCase(),
      chains: (regionChains.get(r) ?? []).map((c) => ({
        chain: c,
        label: CHAIN_LABELS[c] ?? c,
      })),
    }));
}

async function buildSnapshot(): Promise<DataApiSnapshot | null> {
  const settled = await Promise.allSettled(
    BENCH_SLUGS.map((s) => loadBenchFromBlob(s)),
  );

  const loaded: [string, Benchmark][] = BENCH_SLUGS.reduce<
    [string, Benchmark][]
  >((acc, slug, i) => {
    const r = settled[i];
    if (r.status === "fulfilled" && r.value) acc.push([slug, r.value]);
    return acc;
  }, []);

  if (loaded.length === 0) return null;

  // Build group rows
  const groupBenches: Record<DataApiGroup, DataApiBenchRow[]> = {
    "price-feeds": [],
    "token-metadata": [],
    "portfolio-wallet": [],
    "dex-coverage": [],
    "nft-data": [],
  };

  for (const [slug, bench] of loaded) {
    const group = BENCH_GROUP[slug];
    if (!group) continue;
    groupBenches[group].push(toBenchRow(slug, bench));
  }

  // Build provider pivot
  type PEntry = { name: string; cells: DataApiProviderCell[] };
  const providerMap = new Map<string, PEntry>();

  for (const [slug, bench] of loaded) {
    const group = BENCH_GROUP[slug];
    if (!group) continue;
    const live = sortedResults(liveResults(bench), bench.higherIsBetter);
    const regionScores = computeProviderRegionScores(bench, live);
    for (const [idx, r] of live.entries()) {
      if (!providerMap.has(r.slug)) {
        providerMap.set(r.slug, { name: r.name, cells: [] });
      }
      const cellWins = computeProviderCellWins(bench, r.slug);
      const regions = cellWins.length === 0 ? regionScores.get(r.slug) : undefined;
      providerMap.get(r.slug)!.cells.push({
        benchSlug: slug,
        benchShortTitle: BENCH_SHORT_TITLE[slug] ?? slug,
        group,
        rank: idx + 1,
        p50: r.ms.p50,
        unit: bench.unit,
        higherIsBetter: bench.higherIsBetter,
        regions: regions && regions.length > 0 ? regions : undefined,
        cellWins: cellWins.length > 0 ? cellWins : undefined,
      });
    }
  }

  const providerRows: DataApiProviderPivotRow[] = [];
  for (const [slug, { name, cells }] of providerMap.entries()) {
    const groups: DataApiProviderPivotRow["groups"] = {};
    for (const cell of cells) {
      const cur = groups[cell.group];
      if (!cur || cell.rank < cur.bestRank) {
        groups[cell.group] = { bestRank: cell.rank, bestCell: cell };
      }
    }
    providerRows.push({
      slug,
      name,
      cells,
      groups,
      groupCount: Object.keys(groups).length,
    });
  }

  providerRows.sort((a, b) => {
    if (b.groupCount !== a.groupCount) return b.groupCount - a.groupCount;
    const avgA = a.cells.reduce((s, c) => s + c.rank, 0) / (a.cells.length || 1);
    const avgB = b.cells.reduce((s, c) => s + c.rank, 0) / (b.cells.length || 1);
    return avgA - avgB;
  });

  // Headline stats for KPI strip
  const headLagEntry = loaded.find(([s]) => s === "aggregator-head-lag");
  const indexingEntry = loaded.find(([s]) => s === "indexing-freshness");

  function headlineStat(
    entry: [string, Benchmark] | undefined,
  ): { name: string; value: string } | null {
    if (!entry) return null;
    const [, bench] = entry;
    const best = sortedResults(liveResults(bench), bench.higherIsBetter)[0];
    if (!best) return null;
    return { name: best.name, value: fmtDataValue(best.ms.p50, bench.unit) };
  }

  const groups: DataApiGroupRow[] = GROUP_ORDER.map((g) => ({
    group: g,
    benches: groupBenches[g],
  })).filter((g) => g.benches.length > 0);

  return {
    groups,
    providers: providerRows,
    totals: {
      uniqueProviders: providerMap.size,
      benchCount: loaded.length,
      groupCount: groups.length,
      headlinePriceFeed: headlineStat(headLagEntry),
      headlineIndexing: headlineStat(indexingEntry),
    },
    generatedAt: new Date().toISOString(),
  };
}

export const fetchDataApiSnapshot = unstable_cache(
  buildSnapshot,
  ["data-api-cohort"],
  { revalidate: 60, tags: ["data-api-cohort"] },
);
