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

  test("drops the clause of a typed token whose slug has no live data", () => {
    // The validator guarantees the slug exists in the spec; at request
    // time a missing slug means the provider is down today.
    expect(renderTemplate("{{p50:ghost}}", live)).toBe("");
    expect(
      renderTemplate(
        "Alpha leads at {{best_p50}}; the official endpoint measures {{p50:ghost}}. Second sentence stays.",
        live,
      ),
    ).toBe("Alpha leads at 100 ms. Second sentence stays.");
    expect(
      renderTemplate("First clause; {{p50:ghost}} is down; third clause.", live),
    ).toBe("First clause; third clause.");
    expect(
      renderTemplate("Kept sentence. {{name:ghost}} answers in {{p50:ghost}}.\nNext paragraph.", live),
    ).toBe("Kept sentence.\nNext paragraph.");
  });

  test("renders p90 and the success rate", () => {
    expect(renderTemplate("{{p90:alpha}} / {{success:alpha}}", live)).toBe("100 ms / 100 %");
    const flaky = bench([{ ...r("alpha", "Alpha", 100), successRate: 99.87 }]);
    expect(renderTemplate("{{success:alpha}}", flaky)).toBe("99.9 %");
  });

  test("is case-insensitive on the keyword", () => {
    expect(renderTemplate("{{BEST_NAME}}", live)).toBe("Alpha");
  });

  test("returns input unchanged when no template marker is present", () => {
    expect(renderTemplate("plain text", live)).toBe("plain text");
  });

  test("drops the clause quoting a preset when there are no live providers", () => {
    const empty = bench([]);
    expect(renderTemplate("{{best_name}}", empty)).toBe("");
    expect(renderTemplate("Cohort of {{count}} today. {{best_name}} leads.", empty)).toBe(
      "Cohort of 0 today.",
    );
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

    test("drops the clause when the chain isn't stashed", () => {
      expect(renderTemplate("On BNB, {{best_name:chain:bnb}} leads.", withChains())).toBe("");
    });

    test("drops the clause when bestPerChain is absent", () => {
      const noChain = bench([r("alpha", "Alpha", 100)]);
      expect(renderTemplate("Alpha is live. {{best_name:chain:solana}} leads Solana.", noChain)).toBe(
        "Alpha is live.",
      );
    });

    test("matches chain key case-insensitively against the stash", () => {
      // perp-fees declares dimensions.chain values as `ETH`, `BTC`, `SOL`
      // (uppercase asset codes), so the stash ends up keyed `ETH` etc.
      // Without case folding, `{{best_p50:chain:BTC}}` in an editorial
      // line would fall through and render the raw token.
      const upper = bench([r("alpha", "Alpha", 100), r("beta", "Beta", 200)]);
      upper.bestPerChain = {
        ETH: { name: "Alpha", slug: "alpha", ms: { p50: 100, p90: 0, p99: 0, mean: 100 }, successRate: 1 },
        BTC: { name: "Beta", slug: "beta", ms: { p50: 200, p90: 0, p99: 0, mean: 200 }, successRate: 1 },
      };
      expect(renderTemplate("{{best_name:chain:BTC}}", upper)).toBe("Beta");
      expect(renderTemplate("{{best_p50:chain:eth}}", upper)).toBe("100 ms");
    });
  });
});

describe("renderTemplate, access tiers", () => {
  const keyedRows = [r("alchemy", "Alchemy", 38), r("quicknode", "QuickNode", 29)];
  const withTiers: Benchmark = {
    ...bench([
      { ...r("publicnode", "PublicNode", 44), tier: "public" },
      { ...r("drpc", "dRPC", 61), tier: "public" },
    ]),
    dimensions: {
      tier: [
        { value: "public", label: "Public, no key" },
        { value: "keyed", label: "API key" },
      ],
    },
    tierResults: { keyed: keyedRows },
  };

  test("best_name / best_p50 stay the active cohort's leader", () => {
    expect(renderTemplate("{{best_name}} at {{best_p50}}", withTiers)).toBe("PublicNode at 44 ms");
  });

  test("tier-scoped presets read the other cohort's stash", () => {
    expect(
      renderTemplate("{{best_name:tier:keyed}} at {{best_p50:tier:keyed}}, {{count:tier:keyed}} keyed", withTiers),
    ).toBe("QuickNode at 29 ms, 2 keyed");
    expect(renderTemplate("{{worst_name:tier:keyed}}", withTiers)).toBe("Alchemy");
  });

  test("tier-scoped presets naming the active cohort resolve against it", () => {
    expect(renderTemplate("{{best_name:tier:public}}", withTiers)).toBe("PublicNode");
  });

  test("per-slug lookups fall through to the other cohorts", () => {
    expect(renderTemplate("Alchemy: {{p50:alchemy}}", withTiers)).toBe("Alchemy: 38 ms");
    expect(renderTemplate("{{name:quicknode}}", withTiers)).toBe("QuickNode");
  });

  test("an undeclared tier drops its clause instead of printing the token", () => {
    expect(
      renderTemplate("PublicNode leads; the keyed leader is {{best_name:tier:premium}}.", withTiers),
    ).toBe("PublicNode leads.");
  });
});
