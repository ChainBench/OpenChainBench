import { unstable_cache } from "next/cache";
import { loadBenchFromBlob, loadVariantFromBlob } from "@/lib/bench-blob";
import { filterSig } from "@/lib/materialize/load";
import { dataAgeHours, STALE_AFTER_HOURS } from "@/lib/provider-filters";
import { CORRIDORS, REGIONS } from "@/lib/bridge-hub-types";
import type { CorridorFee, RegionLatency, BridgeProviderRow, BridgeHubData } from "@/lib/bridge-hub-types";
export type { CorridorKey, RegionKey, CorridorFee, RegionLatency, BridgeProviderRow, BridgeHubData } from "@/lib/bridge-hub-types";
export { CORRIDORS, REGIONS } from "@/lib/bridge-hub-types";

async function _fetchBridgeHub(): Promise<BridgeHubData | null> {
  const nCorridors = CORRIDORS.length;
  const nRegions = REGIONS.length;

  const results = await Promise.all([
    loadBenchFromBlob("bridge-fee"),
    loadBenchFromBlob("bridge-quote-latency"),
    // Per-corridor fee variants (p50 + p99)
    ...CORRIDORS.map((c) =>
      loadVariantFromBlob("bridge-fee", filterSig({ chain: c.value }))
    ),
    // Per-region latency variants (p50)
    ...REGIONS.map((r) =>
      loadVariantFromBlob("bridge-quote-latency", filterSig({ region: r.value }))
    ),
  ]);

  const feeBench = results[0];
  const latencyBench = results[1];
  const corridorVariants = results.slice(2, 2 + nCorridors);
  const regionVariants = results.slice(2 + nCorridors, 2 + nCorridors + nRegions);

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

  // Per-corridor: slug → { p50, p99 }
  const corridorP50Maps = corridorVariants.map(
    (variant) =>
      new Map(
        (variant?.results ?? []).map((r) => [
          r.slug,
          r.availability !== "unavailable" ? (r.ms.p50 ?? null) : null,
        ])
      )
  );
  const corridorP99Maps = corridorVariants.map(
    (variant) =>
      new Map(
        (variant?.results ?? []).map((r) => [
          r.slug,
          r.availability !== "unavailable" ? (r.ms.p99 ?? null) : null,
        ])
      )
  );

  // Per-region latency: slug → p50. A region whose variant the worker no
  // longer materializes (the region dimension was scoped to EU-West on
  // 2026-09-10) keeps its last blob in KV: the US and Singapore columns
  // showed 2026-09-09 figures as current for ten days. A variant older
  // than the stale threshold is treated as absent.
  const regionMaps = regionVariants.map(
    (variant) =>
      new Map(
        (variant && dataAgeHours(variant) <= STALE_AFTER_HOURS ? variant.results : []).map((r) => [
          r.slug,
          r.availability !== "unavailable" ? (r.ms.p50 ?? null) : null,
        ])
      )
  );
  // Regions with at least one live cell; the table renders only these.
  const liveRegions = REGIONS.filter((_, i) =>
    [...regionMaps[i].values()].some((v) => v != null && Number.isFinite(v))
  ).map((r) => r.value);

  const providers: BridgeProviderRow[] = [];
  for (const slug of slugSet) {
    const feeRow = feeBySlug.get(slug);
    const latRow = latBySlug.get(slug);
    const base = feeRow ?? latRow!;
    const feeAlive = feeRow?.availability !== "unavailable";
    const latAlive = latRow?.availability !== "unavailable";

    const corridors: CorridorFee[] = CORRIDORS.map((c, i) => ({
      corridor: c.value,
      feep50: corridorP50Maps[i].get(slug) ?? null,
      feep99: corridorP99Maps[i].get(slug) ?? null,
    }));

    const regions: RegionLatency[] = REGIONS.map((r, i) => ({
      region: r.value,
      quotep50: regionMaps[i].get(slug) ?? null,
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
      regions,
    });
  }

  // Drop providers with no usable data (dropped from bench spec but still in stale blob)
  const active = providers.filter(
    (p) => p.feep50 != null || p.quotep50 != null || p.corridors.some((c) => c.feep50 != null)
  );

  active.sort(
    (a, b) => (a.feep50 ?? Infinity) - (b.feep50 ?? Infinity)
  );

  const byQuote = [...active]
    .filter((p) => p.quotep50 != null)
    .sort((a, b) => (a.quotep50 ?? Infinity) - (b.quotep50 ?? Infinity));

  const cheapest = active.find((p) => p.feep50 != null) ?? null;
  const fastest = byQuote[0] ?? null;

  const corridorsDisplay =
    feeBench?.dimensions?.chain ?? latencyBench?.dimensions?.chain ?? [];

  const regionCount = Math.max(1, liveRegions.length);

  // Newest measurement across the two benches, for the "as of" line.
  const asOf =
    [feeBench?.lastRunAt, latencyBench?.lastRunAt]
      .filter((t): t is string => Boolean(t) && Number.isFinite(Date.parse(t as string)))
      .sort()
      .at(-1) ?? null;

  return {
    providers: active,
    corridors: corridorsDisplay,
    cheapestSlug: cheapest?.slug ?? null,
    cheapestName: cheapest?.name ?? null,
    cheapestP50: cheapest?.feep50 ?? null,
    fastestSlug: fastest?.slug ?? null,
    fastestName: fastest?.name ?? null,
    fastestP50: fastest?.quotep50 ?? null,
    bridgeCount: active.length,
    regionCount,
    liveRegions,
    asOf,
  };
}

export const fetchBridgeHub = unstable_cache(
  _fetchBridgeHub,
  ["bridge-hub"],
  { revalidate: 300 }
);
