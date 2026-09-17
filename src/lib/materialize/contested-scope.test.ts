import { describe, expect, test } from "bun:test";
import { applyContestedChainScope } from "./load";
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

// Bench 008 as it shipped: stellar, xrp and bitcoin carry one measured
// provider each, so the cross-chain average put two single-chain providers
// first and second above one that led four contested chains.
function fixture() {
  const results = [
    r("stellarexpert", 80.08),
    r("xrpscan", 79.84),
    r("serialized", 76.98),
    r("mobula", 46.75),
  ];
  const providersPerChain: Record<string, string[]> = {
    ethereum: ["serialized", "mobula"],
    base: ["serialized", "mobula"],
    solana: ["serialized", "mobula"],
    stellar: ["stellarexpert"],
    xrp: ["xrpscan"],
  };
  const valuesByChain: Record<string, Record<string, number>> = {
    ethereum: { serialized: 96.84, mobula: 50.0 },
    base: { serialized: 76.36, mobula: 40.0 },
    solana: { serialized: 57.79, mobula: 30.0 },
    stellar: { stellarexpert: 80.08 },
    xrp: { xrpscan: 79.84 },
  };
  return { results, providersPerChain, valuesByChain };
}

describe("contested-chain scoring", () => {
  test("the value becomes the mean over contested chains", () => {
    const { results, providersPerChain, valuesByChain } = fixture();
    applyContestedChainScope(results, providersPerChain, valuesByChain);
    const s = results.find((x) => x.slug === "serialized")!;
    // (96.84 + 76.36 + 57.79) / 3
    expect(s.ms.p50).toBeCloseTo(76.9967, 3);
    expect(s.ms.mean).toBeCloseTo(76.9967, 3);
    expect(results.find((x) => x.slug === "mobula")!.ms.p50).toBeCloseTo(40, 6);
  });

  test("a provider with no contested chain drops out of the ranked field", () => {
    const { results, providersPerChain, valuesByChain } = fixture();
    applyContestedChainScope(results, providersPerChain, valuesByChain);
    expect(results.find((x) => x.slug === "stellarexpert")!.availability).toBe(
      "unavailable",
    );
    expect(results.find((x) => x.slug === "xrpscan")!.availability).toBe(
      "unavailable",
    );
    expect(results.find((x) => x.slug === "serialized")!.availability).toBe("live");
  });

  test("no contested chain at all leaves every value untouched", () => {
    const { results, valuesByChain } = fixture();
    applyContestedChainScope(
      results,
      { stellar: ["stellarexpert"], xrp: ["xrpscan"] },
      valuesByChain,
    );
    expect(results.find((x) => x.slug === "serialized")!.ms.p50).toBe(76.98);
    expect(results.every((x) => x.availability === "live")).toBe(true);
  });

  test("an already unavailable provider is left alone", () => {
    const { results, providersPerChain, valuesByChain } = fixture();
    results[0].availability = "unavailable";
    applyContestedChainScope(results, providersPerChain, valuesByChain);
    expect(results[0].ms.p50).toBe(80.08);
  });
});
