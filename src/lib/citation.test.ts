import { describe, expect, test } from "bun:test";
import { leader, fieldValue, rankedCandidates } from "./citation";
import type { Benchmark, ProviderResult } from "@/types/benchmark";

function r(
  slug: string,
  name: string,
  p50: number,
  successRate = 100,
): ProviderResult {
  return {
    slug,
    name,
    ms: { p50, p90: p50, p99: p50, mean: p50 },
    successRate,
    availability: "live",
  };
}

function bench(results: ProviderResult[]): Benchmark {
  return {
    slug: "test",
    number: "001",
    title: "Test bench",
    subtitle: "",
    lastRunAt: "2026-07-14T00:00:00.000Z",
    status: "live",
    editorialStatus: "live",
    sampleSize: 100,
    abstract: "",
    metric: "Latency",
    unit: "ms",
    higherIsBetter: false,
    category: "RPCs",
    results,
    findings: [],
    methodology: [],
    source: "",
    extras: { series24h: {}, regions: {} },
  };
}

describe("citation reliability threshold", () => {
  test("leader excludes providers with success rate below 50 percent", () => {
    // Owlracle scenario: technically most accurate (lowest p50 gap) but
    // fails 93 percent of calls. Etherscan should win despite a higher p50.
    const b = bench([
      r("owlracle", "Owlracle", 0.001, 6.48),
      r("etherscan", "Etherscan", 1.0, 95.7),
      r("publicnode", "PublicNode", 1.5, 99.99),
    ]);
    const top = leader(b);
    expect(top?.slug).toBe("etherscan");
    expect(top?.value).toBe(1.0);
  });

  test("fieldValue reflects the reliability-filtered leader", () => {
    const b = bench([
      r("owlracle", "Owlracle", 0.001, 6.48),
      r("etherscan", "Etherscan", 1.0, 95.7),
    ]);
    expect(fieldValue(b)).toBe(1.0);
  });

  test("falls back to the full live pool when every provider is unreliable", () => {
    // Bench in a totally degraded state: rather than vanishing from
    // downstream surfaces, surface the least-bad provider so readers
    // still see a live number with the caveats their spec already
    // documents.
    const b = bench([
      r("a", "A", 5, 20),
      r("b", "B", 10, 30),
    ]);
    const top = leader(b);
    expect(top?.slug).toBe("a");
  });

  test("providers with the default 100 percent success rate pass through", () => {
    // Freshness / gauge-only benches never emit a `success` query;
    // the loader defaults to 100 percent, so the guard is inert.
    const b = bench([r("a", "A", 100), r("b", "B", 200)]);
    expect(leader(b)?.slug).toBe("a");
  });

  test("higher-is-better ranks the correct reliable leader", () => {
    const b = bench([
      r("high-but-flaky", "Flaky", 999, 10),
      r("modest-reliable", "Reliable", 50, 100),
      r("mid-reliable", "Mid", 80, 100),
    ]);
    b.higherIsBetter = true;
    // higherIsBetter=true reverses sort so the biggest p50 wins.
    // Flaky wins on raw value but is filtered out; Mid (80) wins the
    // reliable pool.
    expect(leader(b)?.slug).toBe("mid-reliable");
  });

  test("rankedCandidates[0] matches leader for the same bench", () => {
    // Locks the invariant that downstream surfaces (/api/stat rankings,
    // llm-context, MCP resource) can share `rankedCandidates` with
    // `leader()` and never emit a document where the "leader" field
    // contradicts the first entry of the "rankings" list.
    const b = bench([
      r("owlracle", "Owlracle", 0.001, 6.48),
      r("etherscan", "Etherscan", 1.0, 95.7),
      r("publicnode", "PublicNode", 1.5, 99.99),
    ]);
    const top = leader(b);
    const ranks = rankedCandidates(b);
    expect(top?.slug).toBe(ranks[0].slug);
    expect(top?.value).toBe(ranks[0].ms.p50);
  });
});
