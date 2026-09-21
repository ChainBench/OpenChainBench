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

describe("renderTemplate, access tiers, gates and gaps", () => {
  const tiers = [
    { value: "public", label: "Public, no key" },
    { value: "keyed", label: "API key" },
  ];
  const publicRows = [
    { ...r("publicnode", "PublicNode", 44), tier: "public" },
    { ...r("drpc", "dRPC", 61), tier: "public" },
  ];

  test("a keyed row under the success floor never leads the keyed cohort", () => {
    // Chainstack at 40 % success with the lowest p50: the keyed tab's
    // ledger and /api/stat gate it out, so the public page's copy must
    // name the same leader (Alchemy).
    const b: Benchmark = {
      ...bench(publicRows),
      dimensions: { tier: tiers },
      tierResults: {
        keyed: [
          { ...r("chainstack", "Chainstack", 30), successRate: 40 },
          r("alchemy", "Alchemy", 45),
        ],
      },
    };
    expect(renderTemplate("{{best_name:tier:keyed}} at {{best_p50:tier:keyed}}", b)).toBe("Alchemy at 45 ms");
  });

  test("an empty keyed stash drops only the keyed clause of the description", () => {
    // Rollout window (old worker blob without tierResults) and chains
    // whose keyed probes are paused: the public leader claim survives.
    const b: Benchmark = { ...bench(publicRows), dimensions: { tier: tiers } };
    expect(
      renderTemplate(
        "{{best_name}} leads free Base RPC at {{best_p50}} (p50, 24h); {{best_name:tier:keyed}} leads the API-key cohort at {{best_p50:tier:keyed}}. URLs for all {{count}} no-key endpoints.",
        b,
      ),
    ).toBe("PublicNode leads free Base RPC at 44 ms (p50, 24h). URLs for all 2 no-key endpoints.");
  });
});

describe("renderTemplate, a cohort with no citable row", () => {
  test("names nobody: the keyed clause is pruned, the public claim stays", () => {
    // A chain RPC page: the citation gate has no fallback there (a 40 %
    // success endpoint is never crowned), so the stash follows suit.
    const b: Benchmark = {
      ...bench([{ ...r("publicnode", "PublicNode", 44), tier: "public" }, { ...r("drpc", "dRPC", 61), tier: "public" }]),
      slug: "base-rpc",
      title: "Base RPC endpoints: free public URLs and API-key providers by latency",
      dimensions: { tier: [{ value: "public", label: "Public" }, { value: "keyed", label: "API key" }] },
      tierResults: { keyed: [{ ...r("chainstack", "Chainstack", 30), successRate: 40 }] },
    };
    expect(
      renderTemplate("{{best_name}} leads at {{best_p50}}; {{best_name:tier:keyed}} leads the API-key cohort.", b),
    ).toBe("PublicNode leads at 44 ms.");
  });
});
