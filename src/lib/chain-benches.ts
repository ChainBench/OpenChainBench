import { cache } from "react";
import { getBenchmarksSafe } from "@/data/benchmarks";
import type { Benchmark } from "@/types/benchmark";
import {
  CHAIN_SLUG_ALIASES,
  canonicalChainSlug,
} from "@/lib/chain-aliases";

/**
 * Split out of chains.ts, which is a data registry and must stay
 * importable from a client component.
 *
 * This function needs the benchmark loader, and the loader pulls
 * spec.ts -> materialize/store.ts -> ioredis. While it lived next to the
 * registry, anything client-side that touched a chain slug dragged a Redis
 * client into the browser bundle and the build failed on `require("dns")`.
 * Nothing client-side needed the registry until rowHref did, which is why
 * it took until 2026-09-23 to bite.
 */
/**
 * Returns the list of benchmarks that surface this chain in some way:
 *
 *   1. Row shape benches (l1-finality, l2-block-time, network-fees):
 *      the chain is a leaderboard row, matched on `results[].slug`.
 *   2. Dimension shape benches (rpc-capabilities, evm-quote-latency,
 *      aggregator-head-lag, gas-estimation, metadata-coverage):
 *      the chain is a filter dimension, matched on
 *      `dimensions.chain[].value`.
 *
 * Same slug grammar across both shapes (lowercase, kebab-case), so a
 * chain registered here lights up wherever its slug appears in any
 * spec. Adding a new bench that uses a known chain slug surfaces it
 * automatically on the matching `/chains/<slug>` page.
 */
export const getBenchmarksForChain = cache(async function getBenchmarksForChain(
  chainSlug: string,
): Promise<Benchmark[]> {
  const benches = await getBenchmarksSafe();
  // Build the set of slugs that should resolve as this chain: the input
  // itself plus any legacy slug that aliases TO it. This lets the new
  // canonical /chains/<gram> URL still find benches whose results or
  // dimensions still carry the legacy "ton" slug while the YAMLs +
  // materialize snapshots + harness labels rotate over.
  const canon = canonicalChainSlug(chainSlug);
  const accept = new Set<string>([canon]);
  for (const [legacy, target] of Object.entries(CHAIN_SLUG_ALIASES)) {
    if (target === canon) accept.add(legacy);
  }
  // Per-chain benchmark slug conventions. A bench with slug matching one
  // of these patterns for the canonical chain is treated as belonging to
  // it even when it does not carry the chain in results[].slug or
  // dimensions.chain[] (which is the case for chain-scoped RPC benches:
  // `sonic-rpc`, `unichain-rpc`, etc. list providers as results, not the
  // chain itself). Without this, 9 long-tail chains (sonic, gnosis, celo,
  // moonbeam, unichain, soneium, berachain, fraxtal, cronos) drop out of
  // the /chains/<slug> hub and had to be filtered from the sitemap by
  // hand (see prior fix #910). New per-chain bench conventions land here.
  // The keyed cohort lives on the same `<chain>-rpc` page since
  // 2026-09-21 (tier dimension), so the suffix is the only convention.
  const conventionSuffixes = ["-rpc"];
  const acceptedSlugPatterns = new Set<string>();
  for (const slug of accept) {
    for (const suffix of conventionSuffixes) {
      acceptedSlugPatterns.add(`${slug}${suffix}`);
    }
  }

  return benches.filter((b) => {
    if (b.results.some((r) => accept.has(r.slug.toLowerCase()))) return true;
    if (b.dimensions?.chain?.some((c) => accept.has(c.value.toLowerCase())))
      return true;
    if (acceptedSlugPatterns.has(b.slug.toLowerCase())) return true;
    return false;
  });
});
