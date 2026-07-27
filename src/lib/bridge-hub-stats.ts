/**
 * Server-side helper for the /bridge hub page.
 *
 * Loads the bridge-fee blob (aggregate + 4 per-chain variants) and the
 * bridge-quote-latency blob, then merges them into a unified per-provider
 * shape that includes per-corridor breakdowns.
 *
 * No Prometheus queries at render time. All data comes from CDN blobs
 * written by the materialise worker. Degrades gracefully if any blob
 * is unavailable.
 */

import { unstable_cache } from "next/cache";
import { loadBenchFromBlob, loadVariantFromBlob } from "@/lib/bench-blob";
import { filterSig } from "@/lib/materialize/load";
import { CORRIDORS } from "@/lib/bridge-hub-types";
import type { CorridorFee, BridgeProviderRow, BridgeHubData } from "@/lib/bridge-hub-types";
export type { CorridorKey, CorridorFee, BridgeProviderRow, BridgeHubData } from "@/lib/bridge-hub-types";
export { CORRIDORS } from "@/lib/bridge-hub-types";

async function _fetchBridgeHub(): Promise<BridgeHubData | null> {
  // Load aggregate blobs + 4 per-corridor variants for fee bench in parallel
  const [feeBench, latencyBench, ...corridorVariants] = await Promise.all([
    loadBenchFromBlob("bridge-fee"),
    loadBenchFromBlob("bridge-quote-latency"),
    ...CORRIDORS.map((c) =>
      loadVariantFromBlob("bridge-fee", filterSig({ chain: c.value }))
    ),
  ]);

  if (!feeBench && !latencyBench) return null;

  const slugSet = new Set<string>();
  for (const r of feeBench?.results ?? []) slugSet.add(r.slug);
  for (const r of latencyBench?.results ?? []) slugSet.add(r.slug);

  const feeBySlug = new Map(
    (feeBench?.results ?? []).map((r) => [r.slug, r])
  );
  const latBySlug = new Map(
    (latencyBench?.results ?? []).map((r) => [r.slug, r])
  );

  // Per-corridor fee maps: corridorIndex → slug → p50
  const corridorMaps = corridorVariants.map(
    (variant) =>
      new Map(
        (variant?.results ?? []).map((r) => [
          r.slug,
          r.availability !== "unavailable" ? (r.ms.p50 ?? null) : null,
        ])
      )
  );

  const providers: BridgeProviderRow[] = [];
  for (const slug of slugSet) {
    const feeRow = feeBySlug.get(slug);
    const latRow = latBySlug.get(slug);
    const base = feeRow ?? latRow!;
    const feeAlive = feeRow?.availability !== "unavailable";
    const latAlive = latRow?.availability !== "unavailable";

    const corridors: CorridorFee[] = CORRIDORS.map((c, i) => ({
      corridor: c.value,
      feep50: corridorMaps[i].get(slug) ?? null,
    }));

    providers.push({
      slug,
      name: base.name,
      type: base.type,
      tag: base.tag,
      feep50: feeAlive ? (feeRow?.ms.p50 ?? null) : null,
      feep99: feeAlive ? (feeRow?.ms.p99 ?? null) : null,
      feeSuccess: feeRow?.successRate ?? null,
      quotep50: latAlive ? (latRow?.ms.p50 ?? null) : null,
      quotep99: latAlive ? (latRow?.ms.p99 ?? null) : null,
      quoteSuccess: latRow?.successRate ?? null,
      corridors,
    });
  }

  // Sort by fee p50 asc (lower = cheaper), nulls last
  providers.sort(
    (a, b) => (a.feep50 ?? Infinity) - (b.feep50 ?? Infinity)
  );

  const byQuote = [...providers]
    .filter((p) => p.quotep50 != null)
    .sort((a, b) => (a.quotep50 ?? Infinity) - (b.quotep50 ?? Infinity));

  const cheapest = providers.find((p) => p.feep50 != null) ?? null;
  const fastest = byQuote[0] ?? null;

  const corridorsDisplay =
    feeBench?.dimensions?.chain ?? latencyBench?.dimensions?.chain ?? [];

  // Count how many distinct regions the latency bench declares
  const regionDimensions = latencyBench?.dimensions?.region ?? [];
  const regionCount = Math.max(
    1,
    regionDimensions.filter((r) => r.value !== "all").length
  );

  return {
    providers,
    corridors: corridorsDisplay,
    cheapestSlug: cheapest?.slug ?? null,
    cheapestName: cheapest?.name ?? null,
    cheapestP50: cheapest?.feep50 ?? null,
    fastestSlug: fastest?.slug ?? null,
    fastestName: fastest?.name ?? null,
    fastestP50: fastest?.quotep50 ?? null,
    bridgeCount: slugSet.size,
    regionCount,
  };
}

export const fetchBridgeHub = unstable_cache(
  _fetchBridgeHub,
  ["bridge-hub"],
  { revalidate: 60 }
);
