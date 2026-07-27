/**
 * Server-side helper for the /bridge hub page. Loads both bridge bench
 * blobs (bridge-fee and bridge-quote-latency) from the CDN and merges
 * them into a unified per-provider shape.
 *
 * No Prometheus queries at render time. Both benches are already written
 * by the materialise worker, so this is two blob fetches and a join.
 * Degrades gracefully: if only one blob is available, the hub renders
 * whatever columns it has and marks the others null.
 */

import { unstable_cache } from "next/cache";
import { loadBenchFromBlob } from "@/lib/bench-blob";
import type { ProviderType } from "@/types/benchmark";

export type BridgeProviderRow = {
  slug: string;
  name: string;
  type: ProviderType | undefined;
  tag: string | undefined;
  feep50: number | null;
  feep99: number | null;
  feeSuccess: number | null;
  quotep50: number | null;
  quotep99: number | null;
  quoteSuccess: number | null;
};

export type BridgeHubData = {
  providers: BridgeProviderRow[];
  corridors: { value: string; label: string }[];
  cheapestSlug: string | null;
  cheapestName: string | null;
  cheapestP50: number | null;
  fastestSlug: string | null;
  fastestName: string | null;
  fastestP50: number | null;
  bridgeCount: number;
};

async function _fetchBridgeHub(): Promise<BridgeHubData | null> {
  const [feeBench, latencyBench] = await Promise.all([
    loadBenchFromBlob("bridge-fee"),
    loadBenchFromBlob("bridge-quote-latency"),
  ]);

  if (!feeBench && !latencyBench) return null;

  const slugSet = new Set<string>();
  for (const r of feeBench?.results ?? []) slugSet.add(r.slug);
  for (const r of latencyBench?.results ?? []) slugSet.add(r.slug);

  const feeBySlug = new Map(
    (feeBench?.results ?? []).map((r) => [r.slug, r]),
  );
  const latBySlug = new Map(
    (latencyBench?.results ?? []).map((r) => [r.slug, r]),
  );

  const providers: BridgeProviderRow[] = [];
  for (const slug of slugSet) {
    const feeRow = feeBySlug.get(slug);
    const latRow = latBySlug.get(slug);
    const base = feeRow ?? latRow!;
    const feeAlive = feeRow?.availability !== "unavailable";
    const latAlive = latRow?.availability !== "unavailable";
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
    });
  }

  // Sort by fee p50 asc (lower = cheaper), nulls last
  providers.sort(
    (a, b) => (a.feep50 ?? Infinity) - (b.feep50 ?? Infinity),
  );

  const byQuote = [...providers]
    .filter((p) => p.quotep50 != null)
    .sort((a, b) => (a.quotep50 ?? Infinity) - (b.quotep50 ?? Infinity));

  const cheapest = providers.find((p) => p.feep50 != null) ?? null;
  const fastest = byQuote[0] ?? null;

  const corridors =
    feeBench?.dimensions?.chain ?? latencyBench?.dimensions?.chain ?? [];

  return {
    providers,
    corridors,
    cheapestSlug: cheapest?.slug ?? null,
    cheapestName: cheapest?.name ?? null,
    cheapestP50: cheapest?.feep50 ?? null,
    fastestSlug: fastest?.slug ?? null,
    fastestName: fastest?.name ?? null,
    fastestP50: fastest?.quotep50 ?? null,
    bridgeCount: slugSet.size,
  };
}

export const fetchBridgeHub = unstable_cache(
  _fetchBridgeHub,
  ["bridge-hub"],
  { revalidate: 60 },
);
