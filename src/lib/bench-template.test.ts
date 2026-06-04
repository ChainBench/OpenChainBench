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
});
