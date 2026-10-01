import { describe, expect, test } from "bun:test";
import { compactRow, compareOnBenchmark, matchUseCase, redactSecrets, scoreBenchmark, searchBenchmarks } from "./mcp-tools";
import type { Benchmark, ProviderResult } from "@/types/benchmark";

const SITE = "https://openchainbench.com";

// successRate is a percentage here, not a fraction: the citation layer drops
// anything under 50, so `1` would mean "fails 99% of calls" and every
// provider would be excluded from the ranking.
function r(slug: string, name: string, p50: number, successRate = 100): ProviderResult {
  return { slug, name, ms: { p50, p90: p50, p99: p50, mean: p50 }, successRate, availability: "live" };
}

function bench(over: Partial<Benchmark> = {}): Benchmark {
  return {
    slug: "solana-rpc",
    number: "001",
    title: "Fastest Solana RPC",
    subtitle: "",
    lastRunAt: "2026-10-01T00:00:00.000Z",
    status: "live",
    editorialStatus: "live",
    sampleSize: 100,
    abstract: "",
    metric: "Call latency",
    unit: "ms",
    higherIsBetter: false,
    category: "RPCs",
    results: [r("helius", "Helius", 120), r("triton", "Triton One", 180)],
    findings: [],
    methodology: [],
    source: "",
    extras: { series24h: {}, regions: {} },
    ...over,
  } as Benchmark;
}

describe("unit conversion at the MCP boundary", () => {
  test('a unit "s" bench publishes seconds, not the stored milliseconds', () => {
    // The bug this guards: latency benches declaring unit "s" store ms (the
    // fmtUnit convention in format.ts). The MCP endpoint served
    // {"value":443.494,"unit":"s"} for a head lag the site and /api/stat both
    // render as 0.44 s. A thousandfold error under provider names, on three
    // benches including number 001.
    const b = bench({
      slug: "aggregator-head-lag",
      unit: "s",
      results: [r("serialized", "Serialized", 443.494)],
    });
    const row = compactRow(b, SITE);
    expect(row.unit).toBe("s");
    expect(row.value).toBeCloseTo(0.443494, 6);
  });

  test('a unit "ms" bench is left alone', () => {
    expect(compactRow(bench(), SITE).value).toBe(120);
  });
});

describe("search ranks the catalogue against a user's words", () => {
  const pool = [
    bench(),
    bench({
      slug: "base-rpc",
      title: "Fastest Base RPC",
      results: [r("alchemy", "Alchemy", 90), r("quicknode", "QuickNode", 110)],
    }),
    bench({
      slug: "bridge-fee",
      title: "Cheapest bridge",
      category: "Bridges",
      metric: "Cost",
      results: [r("across", "Across", 12), r("stargate", "Stargate", 18)],
    }),
  ];

  test("finds a bench by chain name", () => {
    const hits = searchBenchmarks(pool, { query: "which solana rpc is fastest", limit: 5, siteUrl: SITE });
    expect(hits[0].slug).toBe("solana-rpc");
  });

  test("finds a bench by a provider it measures, not only by its title", () => {
    // "is Helius faster than Triton" names no chain and no benchmark; the
    // provider names are the only signal, so they have to be in the haystack.
    const hits = searchBenchmarks(pool, { query: "helius triton", limit: 5, siteUrl: SITE });
    expect(hits[0].slug).toBe("solana-rpc");
  });

  test("matches provider names the user capitalises differently", () => {
    const hits = searchBenchmarks(pool, { query: "Alchemy or QuickNode", limit: 5, siteUrl: SITE });
    expect(hits[0].slug).toBe("base-rpc");
  });

  test("does not rank on a superlative alone", () => {
    // Every latency bench ties on "fastest", so it carries no signal and is
    // dropped before scoring: an empty result is honest, an arbitrary one is not.
    expect(searchBenchmarks(pool, { query: "fastest", limit: 5, siteUrl: SITE })).toHaveLength(0);
  });

  test("caps the result set so the catalogue never ships in one response", () => {
    const many = Array.from({ length: 60 }, (_, i) => bench({ slug: `chain-${i}-rpc` }));
    expect(searchBenchmarks(many, { limit: 50, siteUrl: SITE })).toHaveLength(50);
    expect(searchBenchmarks(many, { category: "RPCs", siteUrl: SITE })).toHaveLength(10);
  });

  test("scores a precise query above a rambling one for the same bench", () => {
    expect(scoreBenchmark(pool[0], "solana rpc")).toBeGreaterThan(
      scoreBenchmark(pool[0], "i was wondering what the solana rpc situation is these days"),
    );
  });
});

describe("use case matching", () => {
  test("prefers the longest phrase, so a trading bot is not merely a bot", () => {
    expect(matchUseCase("building a solana trading bot")?.id).toBe("trading-bot");
  });
  test("returns null when nothing matches rather than guessing", () => {
    expect(matchUseCase("a recipe for bolognese")).toBeNull();
  });
});

describe("head to head comparison", () => {
  test("ranks the providers it measures", () => {
    const c = compareOnBenchmark(bench(), ["Helius", "Triton One"], SITE);
    expect(c.rows.map((row) => [row.slug, row.rank])).toEqual([
      ["helius", 1],
      ["triton", 2],
    ]);
    expect(c.missing).toEqual([]);
  });

  test("reports an unmeasured provider as missing, never as a loser", () => {
    // "we do not measure Infura here" and "Infura came last" are different
    // answers, and returning the second when the first is true is how a
    // comparison tool starts lying.
    const c = compareOnBenchmark(bench(), ["Helius", "Infura"], SITE);
    expect(c.missing).toEqual(["infura"]);
    expect(c.rows.map((row) => row.slug)).toEqual(["helius"]);
  });

  test("converts compared values into the declared unit too", () => {
    const b = bench({ unit: "s", results: [r("serialized", "Serialized", 443.494)] });
    const c = compareOnBenchmark(b, ["Serialized", "Nobody"], SITE);
    expect(c.rows[0].value).toBeCloseTo(0.443494, 6);
    expect(c.missing).toEqual(["nobody"]);
  });
});

describe("a query is never echoed back with a secret in it", () => {
  // Found by calling production: asked to search for "my API key abc123SECRET",
  // the endpoint returned the secret inside its own payload. Nothing stored it,
  // but it reached the model's context and whatever the client logs, and the
  // rule here is that a key appears in none of those.
  test("redacts a named credential", () => {
    expect(redactSecrets("test my RPC with my api key abc123SECRETVALUE")).not.toContain("abc123SECRETVALUE");
  });

  test("redacts a bare high-entropy run", () => {
    expect(redactSecrets("use vcp_4Zj1bbjGZf1m4tUxJ52RD4SCW")).toBe("use [redacted]");
  });

  test("redacts a keyed endpoint", () => {
    expect(redactSecrets("https://eth.example.com/v2/deadbeefkey")).toBe("[redacted-url]");
  });

  test("leaves an ordinary question alone", () => {
    expect(redactSecrets("which solana rpc is fastest")).toBe("which solana rpc is fastest");
    expect(redactSecrets("Alchemy or QuickNode on Base")).toBe("Alchemy or QuickNode on Base");
  });
});

describe("weak matches are not published as relevant", () => {
  const pool = [
    bench(),
    bench({ slug: "buyback-audit", title: "Buyback audit", category: "Trading", results: [r("x", "X", 1)] }),
  ];

  test("a prefix-only hit is below the floor", () => {
    // "buy SOL for me" scored buyback-audit and three Solana benches on three
    // leading letters. Eight results for a question that matches nothing is
    // noise a model may read as relevance.
    expect(searchBenchmarks(pool, { query: "buy SOL for me", siteUrl: SITE })).toHaveLength(0);
  });

  test("a real provider-name match still clears it", () => {
    const hits = searchBenchmarks(pool, { query: "helius triton", siteUrl: SITE });
    expect(hits.map((h) => h.slug)).toEqual(["solana-rpc"]);
  });
});
