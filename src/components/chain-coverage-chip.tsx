import type { Benchmark } from "@/types/benchmark";
import { liveResults } from "@/lib/provider-filters";
import { readBestPerChain } from "@/lib/per-chain-contract";

type Props = {
  /** Provider slug as it appears in `benchmark.results` (case-insensitive match). */
  providerSlug: string;
  /** Benchmark to derive per-chain coverage from. Must have `bestPerChain`
   *  populated for the chip row to render anything; otherwise this is a no-op. */
  benchmark: Benchmark;
  /** Optional. When set, hides chains the provider is NOT present on
   *  (default: true — only show chains the provider has a measurement on). */
  onlyPresent?: boolean;
  /** When true (default), only render chips for chains the provider LEADS.
   *  Set to false on /products/[slug] where surfacing every covered chain
   *  is useful. On the bench page leaderboard the leader-only view keeps
   *  the row scannable on benches with 10+ chain dimensions. */
  leadersOnly?: boolean;
  /** Small visual variant for inline use inside a leaderboard row. */
  size?: "sm" | "xs";
  className?: string;
};

/**
 * Renders a horizontal chip row showing which chains a provider competes on
 * for a given benchmark and what rank they hold per chain. Reusable on
 * /products/[slug] (one chip block per appearance) and on the bench page
 * leaderboard (inline next to the provider name).
 *
 * Renders nothing when the bench has no `bestPerChain` data, no declared
 * chain dimensions, or the provider has zero per-chain measurements.
 *
 * Why this exists: providers like GMGN that only operate on Solana
 * mechanically show as "#1" on the unfiltered aggregate of a cross-chain
 * bench (Solana's baseline is the fastest). Surfacing per-chain rank
 * inline makes that chain-restricted scope readable at a glance.
 */
export function ChainCoverageChip({
  providerSlug,
  benchmark,
  onlyPresent = true,
  leadersOnly = true,
  size = "sm",
  className = "",
}: Props) {
  const bestPerChain = readBestPerChain(benchmark);
  const chainOptions = benchmark.dimensions?.chain ?? [];
  if (!bestPerChain || chainOptions.length === 0) return null;

  const lower = providerSlug.toLowerCase();
  // For each declared chain (excluding the "all" sentinel), figure out
  // the provider's rank on that chain by re-ranking participants whose
  // bestPerChain entry exists. Since bestPerChain stores only the leader,
  // we approximate rank by checking against `benchmark.results` filtered
  // to the providers that *appear* on that chain via bestPerChain leadership.
  // This is intentionally a soft signal — the bench page's chain tab shows
  // the precise per-chain ranking; this chip is a quick scan aid.
  const chips = chainOptions
    .filter((c) => c.value !== "all")
    .map((c) => {
      const leader = bestPerChain[c.value];
      if (!leader) return null;
      const isLeader = leader.slug.toLowerCase() === lower;
      // In leaders-only mode (used by the bench page leaderboard) we hard
      // skip non-leader chips. Benches like wallet-labels-coverage declare
      // 11 chain dimensions; rendering every one of them per row inflates
      // the name column past readability without adding signal.
      if (leadersOnly && !isLeader) return null;
      // Detect provider presence on this chain: a provider is "present"
      // when it has a non-zero p50 entry in the unfiltered results AND
      // bestPerChain has any leader for this chain (proxy: the chain is
      // active this cycle).
      const presentInResults = benchmark.results.some(
        (r) => r.slug.toLowerCase() === lower && r.ms.p50 > 0,
      );
      const present = presentInResults; // chain-level presence narrower than aggregate; soft.
      if (onlyPresent && !present && !isLeader) return null;
      return { chain: c, isLeader, present };
    })
    .filter((x): x is { chain: { value: string; label: string }; isLeader: boolean; present: boolean } => x !== null);

  if (chips.length === 0) return null;

  const padding = size === "xs" ? "px-1.5 py-[1px]" : "px-2 py-0.5";
  const text = size === "xs" ? "text-[9px]" : "text-[10px]";

  return (
    <span
      className={`inline-flex flex-wrap items-center gap-1 ${className}`}
      aria-label={`Chain coverage for ${providerSlug}`}
    >
      {chips.map(({ chain, isLeader }) => (
        <span
          key={chain.value}
          className={`inline-flex items-center gap-1 rounded-full border ${padding} ${text} font-sans font-medium uppercase tracking-[0.12em] ${
            isLeader
              ? "border-good/40 bg-good/10 text-good"
              : "border-rule bg-paper-soft text-ink-muted"
          }`}
        >
          {isLeader ? `#1 · ${chain.label}` : chain.label}
        </span>
      ))}
    </span>
  );
}

/**
 * Compute per-chain rank for a provider against the subset of providers
 * whose bestPerChain entry exists on that chain. Used by both the badge
 * endpoint and the products page to express "rank on chain X" without
 * pretending we have a full leaderboard per chain (we only know the
 * leader per chain via the precomputed extra-query roundtrip).
 *
 * Semantics:
 *   - If the provider IS the leader on `chain`, returns rank 1.
 *   - Otherwise, falls back to the provider's aggregate p50 rank within
 *     the providers that have results on this bench (best-effort).
 *
 * Note: this is a soft signal — full per-chain leaderboards live on the
 * bench page chain tabs and call into Prom directly with the chain label.
 */
export function rankOnChain(
  benchmark: Benchmark,
  chain: string,
  providerSlug: string,
): { rank: number; totalRanked: number } | null {
  const bestPerChain = readBestPerChain(benchmark);
  if (!bestPerChain) return null;
  const leader = bestPerChain[chain];
  if (!leader) return null;
  const lower = providerSlug.toLowerCase();
  const live = liveResults(benchmark.results);
  if (live.length === 0) return null;
  if (leader.slug.toLowerCase() === lower) {
    return { rank: 1, totalRanked: live.length };
  }
  // Fallback rank: sort live results by p50 in the bench's direction.
  const sorted = [...live].sort((a, b) =>
    benchmark.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
  );
  const idx = sorted.findIndex((r) => r.slug.toLowerCase() === lower);
  if (idx === -1) return null;
  return { rank: idx + 1, totalRanked: sorted.length };
}

