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
  // Per-chain values, used to rescore over the common basket.
  const valuesByChain: Record<string, Record<string, number>> = {
    ethereum: { kyberswap: 199, mobula: 470, lifi: 700, bebop: 650, cow: 1800 },
    base: { kyberswap: 185, mobula: 480, lifi: 720, bebop: 660, cow: 1850 },
    arbitrum: { kyberswap: 246, mobula: 490, lifi: 740, bebop: 700, cow: 1900 },
    bsc: { kyberswap: 250, mobula: 500, lifi: 760, bebop: 720 },
    robinhood: { route: 215, kyberswap: 244, lifi: 648 },
  };
  return { results, providersPerChain, labels, valuesByChain };
}

describe("applyFullCoverageScope", () => {
  test("a provider with nothing in the common basket leaves the ranking", () => {
    const { results, providersPerChain, labels, valuesByChain } = fixture();
    applyFullCoverageScope(results, providersPerChain, labels, valuesByChain);
    const route = results.find((x) => x.slug === "route")!;
    expect(route.unrankedLabel).toBe("Robinhood only");
    expect(route.ms.p50).toBe(0);
    // It answered, so it must not read as a dead endpoint.
    expect(route.availability).toBe("live");
  });

  // The over-correction this rule exists to avoid: demanding every chain
  // unranked Mobula, Bebop and CoW too and left a two-name board.
  test("a provider missing only the thin chain stays ranked", () => {
    const { results, providersPerChain, labels, valuesByChain } = fixture();
    applyFullCoverageScope(results, providersPerChain, labels, valuesByChain);
    for (const slug of ["mobula", "bebop", "cow"]) {
      const row = results.find((x) => x.slug === slug)!;
      expect(row.unrankedLabel).toBeUndefined();
      expect(row.ms.p50).toBeGreaterThan(0);
    }
  });

  test("the published value is the mean over the basket, not over everything", () => {
    const { results, providersPerChain, labels, valuesByChain } = fixture();
    applyFullCoverageScope(results, providersPerChain, labels, valuesByChain);
    // KyberSwap over ethereum, base, arbitrum, bsc: Robinhood is out.
    const kyber = results.find((x) => x.slug === "kyberswap")!;
    expect(kyber.ms.p50).toBeCloseTo((199 + 185 + 246 + 250) / 4, 6);
    // CoW has no BSC row, so it is scored on the three it does cover.
    const cow = results.find((x) => x.slug === "cow")!;
    expect(cow.ms.p50).toBeCloseTo((1800 + 1850 + 1900) / 3, 6);
  });

  test("the leader after the fix is the provider that leads the shared chains", () => {
    const { results, providersPerChain, labels, valuesByChain } = fixture();
    applyFullCoverageScope(results, providersPerChain, labels, valuesByChain);
    const ranked = results
      .filter((x) => !x.unrankedLabel && x.ms.p50 > 0)
      .sort((a, b) => a.ms.p50 - b.ms.p50);
    expect(ranked[0].slug).toBe("kyberswap");
    expect(ranked.length).toBe(5);
  });

  test("one chain is not a cross-chain comparison, so nothing changes", () => {
    const results = [r("route", 214.96), r("kyberswap", 224.74)];
    applyFullCoverageScope(
      results,
      { robinhood: ["route", "kyberswap"] },
      { robinhood: "Robinhood" },
      { robinhood: { route: 215, kyberswap: 244 } },
    );
    expect(results.every((x) => x.unrankedLabel === undefined)).toBe(true);
    expect(results[0].ms.p50).toBe(214.96);
  });

  test("an unavailable provider is left alone", () => {
    const { results, providersPerChain, labels, valuesByChain } = fixture();
    const dead = r("openocean", 0);
    dead.availability = "unavailable";
    results.push(dead);
    applyFullCoverageScope(results, providersPerChain, labels, valuesByChain);
    expect(results.find((x) => x.slug === "openocean")!.unrankedLabel).toBeUndefined();
  });
});
