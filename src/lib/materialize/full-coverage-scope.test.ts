import { describe, expect, test } from "bun:test";
import { applyFullCoverageScope } from "./load";
import type { ProviderResult } from "@/types/benchmark";

function r(slug: string, p50: number): ProviderResult {
  return {
    slug,
    name: slug,
    ms: { p50, p90: p50, p99: p50, mean: p50 },
    successRate: 100,
    availability: "live",
  };
}

// Bench 033 as it shipped on 2026-10-19. Route quotes Robinhood Chain
// alone, so its all-chains figure was the mean of three Robinhood cells,
// 215 ms, and it ranked above KyberSwap's mean of fifteen cells across
// five chains, 225 ms. The page called Route the fastest EVM swap quote
// API overall, on four chains it never enters.
//
// Robinhood joined two days earlier and only three of the six live
// providers reach it, so it is not the ground the field shares.
function fixture() {
  const results = [
    r("route", 214.96),
    r("kyberswap", 224.74),
    r("mobula", 478.88),
    r("lifi", 736.9),
    r("bebop", 687.9),
    r("cow", 1874.7),
  ];
  const providersPerChain: Record<string, string[]> = {
    ethereum: ["kyberswap", "mobula", "lifi", "bebop", "cow"],
    base: ["kyberswap", "mobula", "lifi", "bebop", "cow"],
    arbitrum: ["kyberswap", "mobula", "lifi", "bebop", "cow"],
    bsc: ["kyberswap", "mobula", "lifi", "bebop"],
    robinhood: ["route", "kyberswap", "lifi"],
  };
  const labels = {
    ethereum: "Ethereum",
    base: "Base",
    arbitrum: "Arbitrum",
    bsc: "BSC",
    robinhood: "Robinhood",
  };
  // Per-chain percentiles, used to rescore over the common basket. The
  // tail is deliberately far from the median so a regression that copies
  // the p50 into p90 and p99 fails loudly: that is what shipped on
  // 2026-10-19 and hid CoW's 4,961 ms Arbitrum p99 behind 1,658.
  const m = (p50: number, p99: number) => ({ p50, p90: p50 * 1.5, p99, mean: p50 });
  const spreadsByChain = {
    ethereum: {
      kyberswap: m(199, 900), mobula: m(470, 1500), lifi: m(700, 2000),
      bebop: m(650, 1800), cow: m(1800, 4000),
    },
    base: {
      kyberswap: m(185, 800), mobula: m(480, 1400), lifi: m(720, 2100),
      bebop: m(660, 1900), cow: m(1850, 4200),
    },
    arbitrum: {
      kyberswap: m(246, 610), mobula: m(490, 1600), lifi: m(740, 2200),
      bebop: m(700, 2000), cow: m(1900, 4961),
    },
    bsc: {
      kyberswap: m(250, 1000), mobula: m(500, 1700), lifi: m(760, 2300),
      bebop: m(720, 2100),
    },
    robinhood: { route: m(215, 932), kyberswap: m(244, 1100), lifi: m(648, 1900) },
  };
  return { results, providersPerChain, labels, spreadsByChain };
}

describe("applyFullCoverageScope", () => {
  test("a provider with nothing in the common basket leaves the ranking", () => {
    const { results, providersPerChain, labels, spreadsByChain } = fixture();
    applyFullCoverageScope(results, providersPerChain, labels, spreadsByChain);
    const route = results.find((x) => x.slug === "route")!;
    expect(route.unrankedLabel).toBe("Robinhood only");
    // The measured value stays: a 0 ms round trip is impossible and
    // rendered as "0 ms" in every percentile column. The label is what
    // takes the row out of the order; citation.ts and the ledger both
    // key on it.
    expect(route.ms.p50).toBe(214.96);
    // It answered, so it must not read as a dead endpoint.
    expect(route.availability).toBe("live");
  });

  // The over-correction this rule exists to avoid: demanding every chain
  // unranked Mobula, Bebop and CoW too and left a two-name board.
  test("a provider missing only the thin chain stays ranked", () => {
    const { results, providersPerChain, labels, spreadsByChain } = fixture();
    applyFullCoverageScope(results, providersPerChain, labels, spreadsByChain);
    for (const slug of ["mobula", "bebop", "cow"]) {
      const row = results.find((x) => x.slug === slug)!;
      expect(row.unrankedLabel).toBeUndefined();
      expect(row.ms.p50).toBeGreaterThan(0);
    }
  });

  test("the published value is the mean over the basket, not over everything", () => {
    const { results, providersPerChain, labels, spreadsByChain } = fixture();
    applyFullCoverageScope(results, providersPerChain, labels, spreadsByChain);
    // KyberSwap over ethereum, base, arbitrum, bsc: Robinhood is out.
    const kyber = results.find((x) => x.slug === "kyberswap")!;
    expect(kyber.ms.p50).toBeCloseTo((199 + 185 + 246 + 250) / 4, 6);
    // CoW has no BSC row, so it is scored on the three it does cover.
    const cow = results.find((x) => x.slug === "cow")!;
    expect(cow.ms.p50).toBeCloseTo((1800 + 1850 + 1900) / 3, 6);
  });

  test("each percentile is averaged on its own, not copied from the p50", () => {
    const { results, providersPerChain, labels, spreadsByChain } = fixture();
    applyFullCoverageScope(results, providersPerChain, labels, spreadsByChain);
    const kyber = results.find((x) => x.slug === "kyberswap")!;
    expect(kyber.ms.p50).toBeCloseTo((199 + 185 + 246 + 250) / 4, 6);
    expect(kyber.ms.p99).toBeCloseTo((900 + 800 + 610 + 1000) / 4, 6);
    // The whole point: the tail must not collapse onto the median.
    expect(kyber.ms.p99).toBeGreaterThan(kyber.ms.p50 * 2);
    const cow = results.find((x) => x.slug === "cow")!;
    expect(cow.ms.p99).toBeCloseTo((4000 + 4200 + 4961) / 3, 6);
  });

  test("the leader after the fix is the provider that leads the shared chains", () => {
    const { results, providersPerChain, labels, spreadsByChain } = fixture();
    applyFullCoverageScope(results, providersPerChain, labels, spreadsByChain);
    const ranked = results
      .filter((x) => !x.unrankedLabel && x.ms.p50 > 0)
      .sort((a, b) => a.ms.p50 - b.ms.p50);
    expect(ranked[0].slug).toBe("kyberswap");
    expect(ranked.length).toBe(5);
  });

  test("one chain is not a cross-chain comparison, so nothing changes", () => {
    const m0 = (p50: number) => ({ p50, p90: p50, p99: p50, mean: p50 });
    const results = [r("route", 214.96), r("kyberswap", 224.74)];
    applyFullCoverageScope(
      results,
      { robinhood: ["route", "kyberswap"] },
      { robinhood: "Robinhood" },
      { robinhood: { route: m0(215), kyberswap: m0(244) } },
    );
    expect(results.every((x) => x.unrankedLabel === undefined)).toBe(true);
    expect(results[0].ms.p50).toBe(214.96);
  });

  test("an unavailable provider is left alone", () => {
    const { results, providersPerChain, labels, spreadsByChain } = fixture();
    const dead = r("openocean", 0);
    dead.availability = "unavailable";
    results.push(dead);
    applyFullCoverageScope(results, providersPerChain, labels, spreadsByChain);
    expect(results.find((x) => x.slug === "openocean")!.unrankedLabel).toBeUndefined();
  });
});
