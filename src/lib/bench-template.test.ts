import { describe, expect, test } from "bun:test";
import { renderTemplate } from "./bench-template";
import type { Benchmark, ProviderResult } from "@/types/benchmark";

function r(slug: string, name: string, p50: number, p99 = p50): ProviderResult {
  return {
    slug,
    name,
    ms: { p50, p90: (p50 + p99) / 2, p99, mean: p50 },
    successRate: 100,
    availability: "live",
  };
}

function bench(results: ProviderResult[]): Benchmark {
  return {
    slug: "test",
    number: "001",
    title: "Test",
    subtitle: "",
    lastRunAt: "",
    status: "live",
    editorialStatus: "live",
    sampleSize: 0,
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

describe("renderTemplate", () => {
  const live = bench([r("alpha", "Alpha", 100), r("beta", "Beta", 250)]);

  test("substitutes a typed token against a provider slug", () => {
    expect(renderTemplate("p50 is {{p50:alpha}}", live)).toBe("p50 is 100 ms");
  });

  test("substitutes the leader and trailer presets", () => {
    expect(
      renderTemplate("{{best_name}} beats {{worst_name}}", live),
    ).toBe("Alpha beats Beta");
  });

  test("formats numeric presets with the bench unit", () => {
    expect(renderTemplate("leader: {{best_p50}}", live)).toBe("leader: 100 ms");
  });

  test("count returns the number of live providers", () => {
    expect(renderTemplate("{{count}} providers", live)).toBe("2 providers");
  });

  test("leaves unknown keyword tokens untouched", () => {
    expect(renderTemplate("{{frobnicate:alpha}}", live)).toBe(
      "{{frobnicate:alpha}}",
    );
  });

  test("leaves typed tokens with unknown slug untouched", () => {
    expect(renderTemplate("{{p50:ghost}}", live)).toBe("{{p50:ghost}}");
  });

  test("is case-insensitive on the keyword", () => {
    expect(renderTemplate("{{BEST_NAME}}", live)).toBe("Alpha");
  });

  test("returns input unchanged when no template marker is present", () => {
    expect(renderTemplate("plain text", live)).toBe("plain text");
  });

  test("leaves presets intact when there are no live providers", () => {
    const empty = bench([]);
    expect(renderTemplate("{{best_name}}", empty)).toBe("{{best_name}}");
  });

  describe("chain-aware placeholders", () => {
    function withChains(): Benchmark {
      const b = bench([r("alpha", "Alpha", 100), r("beta", "Beta", 250)]);
      // Solana leader = Alpha (100ms), trailer = Beta (250ms).
      // Base leader = Beta (180ms), trailer = Alpha (400ms).
      b.bestPerChain = {
        solana: r("alpha", "Alpha", 100),
        base: r("beta", "Beta", 180),
      };
      b.worstPerChain = {
        solana: r("beta", "Beta", 250),
        base: r("alpha", "Alpha", 400),
      };
      return b;
    }

    test("resolves {{best_name:chain:X}} against bestPerChain", () => {
      expect(renderTemplate("{{best_name:chain:solana}}", withChains())).toBe(
        "Alpha",
      );
      expect(renderTemplate("{{best_name:chain:base}}", withChains())).toBe(
        "Beta",
      );
    });

    test("resolves {{best_p50:chain:X}} with unit formatting", () => {
      expect(renderTemplate("{{best_p50:chain:solana}}", withChains())).toBe(
        "100 ms",
      );
    });

    test("resolves {{worst_name:chain:X}} and {{worst_p50:chain:X}}", () => {
      expect(renderTemplate("{{worst_name:chain:base}}", withChains())).toBe(
        "Alpha",
      );
      expect(renderTemplate("{{worst_p50:chain:base}}", withChains())).toBe(
        "400 ms",
      );
    });

    test("leaves the placeholder untouched when the chain isn't stashed", () => {
      expect(renderTemplate("{{best_name:chain:bnb}}", withChains())).toBe(
        "{{best_name:chain:bnb}}",
      );
    });

    test("leaves chain placeholders untouched when bestPerChain is absent", () => {
      const noChain = bench([r("alpha", "Alpha", 100)]);
      expect(renderTemplate("{{best_name:chain:solana}}", noChain)).toBe(
        "{{best_name:chain:solana}}",
      );
    });
  });
});
