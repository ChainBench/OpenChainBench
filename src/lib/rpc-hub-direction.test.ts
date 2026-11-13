import { describe, expect, it } from "bun:test";
import {
  bestAcrossChains,
  buildPivot,
  byHeadline,
  fmtFirstShare,
  isHeadlineReading,
  scopeCohortToRegion,
  type RpcHubChain,
} from "@/lib/rpc-hub-shape";
import { liveRows } from "@/lib/rpc-hub-stats";
import type { ProviderResult } from "@/types/benchmark";

/**
 * The WebSocket races publish a share of first pushes, ranked high to low,
 * where every other /rpc cohort publishes a latency ranked low to high. Read
 * ascending, the share crowns the provider that wins the fewest races, and a
 * 0% loser is dropped as if it had sent nothing. Pinned on the Ethereum race
 * of 2026-11-12: Quicknode first on 60% of its blocks, Chainstack on none.
 */

const row = (slug: string, p50: number): ProviderResult =>
  ({
    slug,
    name: slug,
    availability: "live",
    ms: { p50, p90: 0, p99: 0, mean: 0 },
    successRate: 100,
  }) as unknown as ProviderResult;

const race = [row("chainstack", 0), row("quicknode", 60.4), row("getblock", 39.6)];

describe("liveRows", () => {
  it("ranks a share of first pushes high to low and keeps the 0% row", () => {
    const out = liveRows({ results: race, higherIsBetter: true, zeroIsAValue: true });
    expect(out.map((r) => r.slug)).toEqual(["quicknode", "getblock", "chainstack"]);
  });

  it("leaves a latency cohort as it was: ascending, a 0 dropped", () => {
    const out = liveRows({
      results: [row("a", 12), row("dead", 0), row("b", 7)],
      higherIsBetter: false,
    });
    expect(out.map((r) => r.slug)).toEqual(["b", "a"]);
  });

  it("drops a 0 on a share bench that does not say 0 is a reading", () => {
    const out = liveRows({ results: race, higherIsBetter: true });
    expect(out.map((r) => r.slug)).toEqual(["quicknode", "getblock"]);
  });
});

describe("direction helpers", () => {
  it("orders best first both ways", () => {
    expect([3, 9, 1].sort(byHeadline())).toEqual([1, 3, 9]);
    expect([3, 9, 1].sort(byHeadline(true))).toEqual([9, 3, 1]);
  });

  it("reads a 0 only where the bench allows it", () => {
    expect(isHeadlineReading(0)).toBe(false);
    expect(isHeadlineReading(0, true)).toBe(true);
    expect(isHeadlineReading(Number.NaN, true)).toBe(false);
  });

  it("prints a share, never milliseconds", () => {
    expect(fmtFirstShare(60.4)).toBe("60% first");
    expect(fmtFirstShare(undefined)).toBe("...");
  });
});

const shareChain = (
  chain: string,
  providers: { provider: string; p50Ms: number; regions: Record<string, number> }[],
): RpcHubChain => ({
  chain,
  slug: `${chain}-rpc-ws`,
  name: chain,
  benchTitle: chain,
  providerCount: providers.length,
  unit: "pct",
  higherIsBetter: true,
  best: { provider: providers[0].provider, providerName: providers[0].provider, p50Ms: providers[0].p50Ms },
  regions: {},
  providers: providers.map((p) => ({ ...p, name: p.provider })),
  updatedAt: "2026-11-12T10:00:00Z",
});

describe("a share cohort through the hub transforms", () => {
  const eth = shareChain("ethereum", [
    { provider: "quicknode", p50Ms: 60, regions: { "us-east": 30, sgp: 90 } },
    { provider: "getblock", p50Ms: 40, regions: { "us-east": 70, sgp: 10 } },
  ]);
  const base = shareChain("base", [
    { provider: "chainstack", p50Ms: 75, regions: {} },
    { provider: "quicknode", p50Ms: 25, regions: {} },
  ]);

  it("re-ranks a region scope high to low", () => {
    const scoped = scopeCohortToRegion(
      { chains: [eth], providersPivot: [], totals: { chains: 1, uniqueProviders: 2, regions: 3 } },
      "us-east",
    );
    expect(scoped.chains[0].best?.provider).toBe("getblock");
    expect(scoped.chains[0].best?.p50Ms).toBe(70);
  });

  it("picks the largest share as the best leader across chains", () => {
    const best = bestAcrossChains({ chains: [eth, base] });
    expect(best?.provider).toBe("chainstack");
    expect(best?.unit).toBe("pct");
  });

  it("breaks a pivot rank tie on the larger median share", () => {
    const pivot = buildPivot([
      shareChain("x", [
        { provider: "a", p50Ms: 50, regions: {} },
        { provider: "b", p50Ms: 30, regions: {} },
      ]),
      shareChain("y", [
        { provider: "b", p50Ms: 80, regions: {} },
        { provider: "a", p50Ms: 20, regions: {} },
      ]),
    ]);
    // Same coverage, same median rank: b's median share (55) beats a's (35).
    expect(pivot.map((r) => r.provider)).toEqual(["b", "a"]);
  });
});
