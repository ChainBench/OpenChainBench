import type { CellRankEntry } from "@/types/benchmark";

/**
 * A bench that pins its headline to one chain (`aggregate_filters.chain`)
 * gives a provider that does not serve that chain no headline figure, and
 * its product page used to say "data warming up" for it. That is false
 * when the provider is measured, today, on the bench's other chain tabs:
 * Metastreams on bench 001 has no Base feed (Base is the pin) and streams
 * BNB, Solana and Robinhood, yet read "warming up" for days (2026-11-23).
 *
 * Returns the pinned chain's label and the chains this provider has a cell
 * on, or null when the bench pins no chain, the provider does have a cell
 * on the pinned chain (then a missing figure is a real gap), or it has no
 * cell anywhere (a source that has not reported, where the old label is
 * right). Presence only, never a rank: on a race bench the cells are
 * ordered by median lag while the tabs rank by share of wins.
 */
export function offPinCoverage(
  bench: {
    pinnedChain?: string;
    chainDimensions?: { value: string; label: string }[];
    cellRanks?: Record<string, CellRankEntry[]>;
  },
  providerSlug: string,
): { pinnedLabel: string; chains: string[] } | null {
  const pinned = bench.pinnedChain;
  const dims = bench.chainDimensions;
  const cells = bench.cellRanks;
  if (!pinned || !dims || !cells) return null;
  const slug = providerSlug.toLowerCase();
  const present = new Set<string>();
  for (const [key, entries] of Object.entries(cells)) {
    const chain = key.split("|")[0];
    if (chain === "all") continue;
    if (entries.some((e) => e.slug.toLowerCase() === slug)) present.add(chain.toLowerCase());
  }
  if (present.has(pinned.toLowerCase())) return null;
  const chains = dims
    .filter((c) => c.value !== "all" && present.has(c.value.toLowerCase()))
    .map((c) => c.label);
  if (chains.length === 0) return null;
  const pinnedLabel = dims.find((c) => c.value.toLowerCase() === pinned.toLowerCase())?.label ?? pinned;
  return { pinnedLabel, chains };
}
