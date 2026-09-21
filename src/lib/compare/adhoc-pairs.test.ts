import { describe, expect, test } from "bun:test";
import { adHocPairs } from "./adhoc-pairs";
import type { ProviderProfile } from "@/lib/providers";

function profile(slug: string, benches: Array<[string, string | undefined]>): ProviderProfile {
  return {
    slug,
    name: slug,
    wins: 0,
    categories: ["RPCs"],
    appearances: benches.map(([b, tier]) => ({
      benchmark: {
        slug: b,
        title: b,
        subtitle: "",
        category: "RPCs",
        metric: "RPC latency",
        unit: "ms",
        higherIsBetter: false,
        status: "live",
        lastRunAt: "",
        hasDistribution: false,
      },
      result: { slug, name: slug, ms: { p50: 10, p90: 10, p99: 10, mean: 10 }, successRate: 100, availability: "live" },
      rank: 1,
      totalRanked: 3,
      ...(tier ? { tier } : {}),
    })),
  } as ProviderProfile;
}

const chains = ["ethereum-rpc", "base-rpc", "arbitrum-rpc", "polygon-rpc", "bnb-rpc"];

describe("adHocPairs, access cohorts", () => {
  test("a keyed provider and a public gateway sharing five chain pages are never a pair", () => {
    // Alchemy (private cohort) vs dRPC (public cohort) on the same five
    // benches: the compare page resolves zero shared benches, so the
    // sitemap must not advertise the pair (10 such 404s on 2026-09-21).
    const alchemy = profile("alchemy", chains.map((c) => [c, "keyed"]));
    const drpc = profile("drpc", chains.map((c) => [c, undefined]));
    expect(adHocPairs([alchemy, drpc])).toEqual([]);
  });

  test("two providers in the same cohort still pair", () => {
    const alchemy = profile("alchemy", chains.map((c) => [c, "keyed"]));
    const quicknode = profile("quicknode", chains.map((c) => [c, "keyed"]));
    expect(adHocPairs([alchemy, quicknode]).map((p) => p.slug)).toEqual(["alchemy-vs-quicknode"]);
    const drpc = profile("drpc", chains.map((c) => [c, undefined]));
    const publicnode = profile("publicnode", chains.map((c) => [c, undefined]));
    expect(adHocPairs([drpc, publicnode]).map((p) => p.slug)).toEqual(["drpc-vs-publicnode"]);
  });
});
