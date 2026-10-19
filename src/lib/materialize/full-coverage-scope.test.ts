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
function fixture() {
  const results = [
    r("route", 214.96),
    r("kyberswap", 224.74),
    r("mobula", 478.88),
    r("lifi", 736.9),
  ];
  const providersPerChain: Record<string, string[]> = {
    ethereum: ["kyberswap", "mobula", "lifi"],
    base: ["kyberswap", "mobula", "lifi"],
    arbitrum: ["kyberswap", "mobula", "lifi"],
    bsc: ["kyberswap", "mobula", "lifi"],
    robinhood: ["route", "kyberswap", "lifi"],
  };
  const labels = {
    ethereum: "Ethereum",
    base: "Base",
    arbitrum: "Arbitrum",
    bsc: "BSC",
    robinhood: "Robinhood",
  };
  return { results, providersPerChain, labels };
}

describe("applyFullCoverageScope", () => {
  test("a single-chain provider leaves the ranking and says what it covers", () => {
    const { results, providersPerChain, labels } = fixture();
    applyFullCoverageScope(results, providersPerChain, labels);
    const route = results.find((x) => x.slug === "route")!;
    expect(route.unrankedLabel).toBe("Robinhood only");
    expect(route.ms.p50).toBe(0);
    // It answered, so it must not read as a dead endpoint.
    expect(route.availability).toBe("live");
  });

  test("a provider present on every chain keeps its value and its rank", () => {
    const { results, providersPerChain, labels } = fixture();
    applyFullCoverageScope(results, providersPerChain, labels);
    const kyber = results.find((x) => x.slug === "kyberswap")!;
    expect(kyber.unrankedLabel).toBeUndefined();
    expect(kyber.ms.p50).toBe(224.74);
  });

  test("partial coverage is counted rather than named", () => {
    const { results, providersPerChain, labels } = fixture();
    // Mobula is on four of the five.
    applyFullCoverageScope(results, providersPerChain, labels);
    const mobula = results.find((x) => x.slug === "mobula")!;
    expect(mobula.unrankedLabel).toBe("4 of 5 chains");
  });

  test("one chain is not a cross-chain comparison, so nothing changes", () => {
    const results = [r("route", 214.96), r("kyberswap", 224.74)];
    applyFullCoverageScope(
      results,
      { robinhood: ["route", "kyberswap"] },
      { robinhood: "Robinhood" },
    );
    expect(results.every((x) => x.unrankedLabel === undefined)).toBe(true);
    expect(results[0].ms.p50).toBe(214.96);
  });

  test("a label longer than the twenty-char ceiling falls back to a count", () => {
    const results = [r("someone", 100), r("everywhere", 50)];
    applyFullCoverageScope(
      results,
      { a: ["someone", "everywhere"], b: ["everywhere"] },
      { a: "A Chain With A Very Long Display Name", b: "B" },
    );
    const one = results.find((x) => x.slug === "someone")!;
    expect(one.unrankedLabel).toBe("1/2 chains");
    expect(one.unrankedLabel!.length).toBeLessThanOrEqual(20);
  });

  test("an unavailable provider is left alone", () => {
    const { results, providersPerChain, labels } = fixture();
    const dead = r("openocean", 0);
    dead.availability = "unavailable";
    results.push(dead);
    applyFullCoverageScope(results, providersPerChain, labels);
    expect(results.find((x) => x.slug === "openocean")!.unrankedLabel).toBeUndefined();
  });
});
