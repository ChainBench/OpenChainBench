/**
 * Editorial / draft Benchmark builders. These ship the page when Prom has
 * nothing to say (cold start, blackout), so the shape they emit is what
 * readers actually see. Any silent shape drift here = blank or crashed
 * pages, the exact failure mode the worker is supposed to prevent.
 */
import { describe, expect, test } from "bun:test";
import type { Spec } from "@/lib/spec-schema";
import { buildEditorial, draftPlaceholderForSpec } from "./editorial";

function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    slug: "demo-bench",
    number: "042",
    title: "Demo bench",
    subtitle: "A short subtitle",
    category: "RPCs",
    status: "live",
    metric: "Latency",
    unit: "ms",
    higher_is_better: false,
    abstract: "abstract copy",
    methodology: ["step one"],
    findings: ["finding one"],
    source: "https://example.com",
    seo_title: "Demo SEO Title",
    seo_description: "Demo SEO description copy.",
    faq: [{ q: "Why?", a: "Because." }],
    providers: [
      {
        slug: "alchemy",
        name: "Alchemy",
        tag: "rpc",
        type: "protocol",
        formula: "p50 of last 24h",
        secondary: { label: "Region", value: "us-east" },
        queries: { p50: `latency{provider="alchemy"}` },
      },
      { slug: "infura", name: "Infura" },
    ],
    ...overrides,
  } as unknown as Spec;
}

describe("buildEditorial", () => {
  test("preserves the identity + SEO fields from the spec", () => {
    const ed = buildEditorial(makeSpec());
    expect(ed.slug).toBe("demo-bench");
    expect(ed.number).toBe("042");
    expect(ed.title).toBe("Demo bench");
    expect(ed.seoTitle).toBe("Demo SEO Title");
    expect(ed.seoDescription).toBe("Demo SEO description copy.");
    expect(ed.subtitle).toBe("A short subtitle");
    expect(ed.metric).toBe("Latency");
    expect(ed.unit).toBe("ms");
    expect(ed.higherIsBetter).toBe(false);
  });

  test("propagates faq, methodology, findings, source", () => {
    const ed = buildEditorial(makeSpec());
    expect(ed.faq).toEqual([{ q: "Why?", a: "Because." }]);
    expect(ed.methodology).toEqual(["step one"]);
    expect(ed.findings).toEqual(["finding one"]);
    expect(ed.source).toBe("https://example.com");
  });

  test("mirrors editorialStatus to spec.status", () => {
    expect(buildEditorial(makeSpec({ status: "draft" })).editorialStatus).toBe(
      "draft",
    );
    expect(buildEditorial(makeSpec({ status: "live" })).editorialStatus).toBe(
      "live",
    );
  });
});

describe("draftPlaceholderForSpec", () => {
  test("returns a draft Benchmark with the spec's identity", () => {
    const b = draftPlaceholderForSpec(makeSpec());
    expect(b.status).toBe("draft");
    expect(b.slug).toBe("demo-bench");
    expect(b.title).toBe("Demo bench");
  });

  test("zeros every provider's latency aggregates", () => {
    const b = draftPlaceholderForSpec(makeSpec());
    expect(b.results).toHaveLength(2);
    for (const r of b.results) {
      expect(r.ms).toEqual({ p50: 0, p90: 0, p99: 0, mean: 0 });
      expect(r.successRate).toBe(0);
    }
  });

  test("carries provider identity + secondary + formula through to results", () => {
    const b = draftPlaceholderForSpec(makeSpec());
    const alchemy = b.results.find((r) => r.slug === "alchemy");
    expect(alchemy?.name).toBe("Alchemy");
    expect(alchemy?.tag).toBe("rpc");
    expect(alchemy?.type).toBe("protocol");
    expect(alchemy?.secondary).toEqual({ label: "Region", value: "us-east" });
    expect(alchemy?.formula).toBe("p50 of last 24h");
  });

  test("emits the minimum extras shape the renderer expects", () => {
    const b = draftPlaceholderForSpec(makeSpec());
    expect(b.extras).toEqual({ series24h: {}, regions: {} });
    expect(b.sampleSize).toBe(0);
    // lastRunAt must be a valid ISO so freshness pills don't NaN out
    expect(() => new Date(b.lastRunAt).toISOString()).not.toThrow();
  });
});
