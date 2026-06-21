import { describe, expect, test } from "bun:test";
import {
  AllBenchmarksDraftError,
  aggregateBenchmarks,
  injectLabels,
} from "./spec";
import type { Benchmark } from "@/types/benchmark";
import type { Spec } from "@/lib/spec-schema";

describe("injectLabels", () => {
  test("injects into an empty selector", () => {
    expect(injectLabels("metric{}", { job: "api" })).toBe(`metric{job="api"}`);
  });

  test("appends to an existing selector without duplicating commas", () => {
    expect(
      injectLabels(`metric{region="us"}`, { job: "api" }),
    ).toBe(`metric{region="us",job="api"}`);
  });

  test("does not duplicate a label that's already present", () => {
    expect(
      injectLabels(`metric{job="old"}`, { job: "new" }),
    ).toBe(`metric{job="old"}`);
  });

  test("applies to every selector in a multi-metric query", () => {
    const q = `rate(metric_a{}[5m]) + rate(metric_b{tier="free"}[5m])`;
    const out = injectLabels(q, { region: "eu" });
    expect(out).toContain(`metric_a{region="eu"}`);
    expect(out).toContain(`metric_b{tier="free",region="eu"}`);
  });

  test("escapes double-quotes in label values", () => {
    expect(injectLabels(`m{}`, { tag: `quo"te` })).toBe(`m{tag="quo\\"te"}`);
  });

  test("escapes backslashes in label values", () => {
    expect(injectLabels(`m{}`, { p: `a\\b` })).toBe(`m{p="a\\\\b"}`);
  });

  test("strips newlines from label values to prevent selector breakout", () => {
    expect(injectLabels(`m{}`, { p: "foo\nbar" })).toBe(`m{p="foobar"}`);
  });

  test("no-op when labels object is empty", () => {
    expect(injectLabels(`metric{job="api"}`, {})).toBe(`metric{job="api"}`);
  });

  test("returns query unchanged when there's no selector at all", () => {
    expect(injectLabels("time()", { job: "api" })).toBe("time()");
  });
});

// Regression coverage for the /api/citable poisoning bug (see
// AllBenchmarksDraftError in spec.ts). The aggregator must NEVER return
// a stable all-draft list that gets cached as truth. It either returns
// a list with at least one live bench, or throws AllBenchmarksDraftError
// so unstable_cache preserves the previous good value and downstream
// callers can decide whether to 503 (APIs) or render placeholders (pages).
function fakeSpec(slug: string, status: "live" | "draft" = "live"): Spec {
  return {
    slug,
    number: "000",
    title: `Bench ${slug}`,
    subtitle: "",
    abstract: "",
    metric: "Latency",
    unit: "ms",
    higher_is_better: false,
    category: "RPCs",
    status,
    findings: [],
    methodology: [],
    source: "",
    providers: [],
    queries: { p50: "", p90: "", p99: "", sample_size: "" },
  } as unknown as Spec;
}

function fakeLiveBench(slug: string): Benchmark {
  return {
    slug,
    number: "000",
    title: `Bench ${slug}`,
    subtitle: "",
    lastRunAt: new Date().toISOString(),
    status: "live",
    editorialStatus: "live",
    sampleSize: 1,
    abstract: "",
    metric: "Latency",
    unit: "ms",
    higherIsBetter: false,
    category: "RPCs",
    results: [],
    findings: [],
    methodology: [],
    source: "",
    extras: { series24h: {}, regions: {} },
  } as Benchmark;
}

describe("aggregateBenchmarks (all-draft poisoning regression)", () => {
  test("throws AllBenchmarksDraftError when every per-bench loader rejects", async () => {
    const specs = [fakeSpec("a"), fakeSpec("b"), fakeSpec("c")];
    const loader = async () => {
      throw new Error("prom blackout");
    };
    let caught: unknown = null;
    try {
      await aggregateBenchmarks(specs, loader);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AllBenchmarksDraftError);
    expect((caught as AllBenchmarksDraftError).slugCount).toBe(3);
  });

  test("throws AllBenchmarksDraftError when every loader returns undefined", async () => {
    const specs = [fakeSpec("a"), fakeSpec("b")];
    const loader = async () => undefined;
    await expect(aggregateBenchmarks(specs, loader)).rejects.toBeInstanceOf(
      AllBenchmarksDraftError,
    );
  });

  test("returns the list when at least one bench is live", async () => {
    const specs = [fakeSpec("a"), fakeSpec("b"), fakeSpec("c")];
    const loader = async (slug: string) => {
      if (slug === "b") return fakeLiveBench(slug);
      throw new Error("prom timeout");
    };
    const out = await aggregateBenchmarks(specs, loader);
    expect(out).toHaveLength(3);
    const live = out.filter((b) => b.status === "live");
    expect(live).toHaveLength(1);
    expect(live[0].slug).toBe("b");
  });

  test("never silently returns an all-draft stable list", async () => {
    // The bug being regressed: pre-fix, aggregateBenchmarks returned an
    // all-draft list when Prom was blacked out at cold start, and
    // unstable_cache then served that list as truth for 60s. Any future
    // refactor that drops the throw must trip this test.
    const specs = [fakeSpec("x"), fakeSpec("y")];
    const loader = async () => undefined;
    let threw = false;
    try {
      await aggregateBenchmarks(specs, loader);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(AllBenchmarksDraftError);
    }
    expect(threw).toBe(true);
  });
});
