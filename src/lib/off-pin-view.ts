import { loadBenchmark } from "@/lib/spec";
import { rankProviders } from "@/lib/providers";
import { raceShareOf } from "@/lib/format";
import { offPinCoverage } from "@/lib/off-pin-coverage";
import type { Benchmark, ProviderResult } from "@/types/benchmark";

/**
 * The figure a product page shows for a provider that has none on the
 * bench's pinned chain: its row on the chain tab where it ranks best.
 * Same ranking and same value as that tab (rankProviders, the race share
 * when the bench has one), so the product page never claims a standing
 * the bench page does not show. Metastreams on bench 001: no Base feed,
 * measured on BNB, Solana and Robinhood (2026-11-23).
 */
export type OffPinView = {
  chainLabel: string;
  rank: number;
  totalRanked: number;
  result: ProviderResult;
  raceShare?: { share: number; label: string };
};

export function pickOffPinView(
  tabs: { label: string; bench: Benchmark | undefined }[],
  providerSlug: string,
): OffPinView | null {
  const slug = providerSlug.toLowerCase();
  let best: OffPinView | null = null;
  for (const { label, bench } of tabs) {
    if (!bench) continue;
    const ranked = rankProviders(bench);
    const idx = ranked.findIndex((r) => r.slug.toLowerCase() === slug);
    if (idx < 0) continue;
    const view: OffPinView = {
      chainLabel: label,
      rank: idx + 1,
      totalRanked: ranked.length,
      result: ranked[idx],
      ...(raceShareOf(bench, ranked[idx].slug) ? { raceShare: raceShareOf(bench, ranked[idx].slug)! } : {}),
    };
    // Best relative standing; the first tab in the bench's order wins a tie.
    if (!best || view.rank / view.totalRanked < best.rank / best.totalRanked) best = view;
  }
  return best;
}

export async function loadOffPinView(
  bench: {
    slug: string;
    pinnedChain?: string;
    chainDimensions?: { value: string; label: string }[];
    cellRanks?: Benchmark["cellRanks"];
  },
  providerSlug: string,
): Promise<OffPinView | null> {
  const coverage = offPinCoverage(bench, providerSlug);
  if (!coverage) return null;
  const dims = (bench.chainDimensions ?? []).filter((c) => coverage.chains.includes(c.label));
  const tabs = await Promise.all(
    dims.map(async (c) => ({
      label: c.label,
      bench: await loadBenchmark(bench.slug, { chain: c.value }).catch(() => undefined),
    })),
  );
  return pickOffPinView(tabs, providerSlug);
}
