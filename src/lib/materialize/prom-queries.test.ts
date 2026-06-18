/**
 * Pure-string PromQL helpers. These run on every spec load + every live
 * load + every worker sweep, so a bug here corrupts every dashboard at
 * once. The owner already documented an injectLabels regression that
 * silently mixed every chain's series on a panel; the tests below pin the
 * canonical behavior so the next refactor cannot regress it again.
 */
import { describe, expect, test } from "bun:test";
import type { Spec } from "@/lib/spec-schema";
import {
  applyDimensionsToSpec,
  escapePromLabelValue,
  injectLabels,
  parseDurationSec,
} from "./prom-queries";

describe("injectLabels", () => {
  test("injects into a bare empty selector", () => {
    expect(injectLabels("metric{}", { chain: "ethereum" })).toBe(
      `metric{chain="ethereum"}`,
    );
  });

  test("appends to a non-empty selector with a single comma", () => {
    expect(
      injectLabels(`metric{region="us-east"}`, { chain: "ethereum" }),
    ).toBe(`metric{region="us-east",chain="ethereum"}`);
  });

  test("does not duplicate an already-present label", () => {
    expect(
      injectLabels(`metric{chain="solana"}`, { chain: "ethereum" }),
    ).toBe(`metric{chain="solana"}`);
  });

  test("applies to every selector in a multi-metric expression", () => {
    const q = `rate(metric_a{}[5m]) + rate(metric_b{tier="free"}[5m])`;
    const out = injectLabels(q, { region: "eu-west" });
    expect(out).toContain(`metric_a{region="eu-west"}`);
    expect(out).toContain(`metric_b{tier="free",region="eu-west"}`);
  });

  test("injects multiple labels at once into an empty selector", () => {
    expect(
      injectLabels("m{}", { chain: "base", region: "us-east" }),
    ).toBe(`m{chain="base",region="us-east"}`);
  });

  test("escapes double-quotes in label values (selector-breakout defense)", () => {
    expect(injectLabels(`m{}`, { tag: `quo"te` })).toBe(`m{tag="quo\\"te"}`);
  });

  test("escapes backslashes in label values", () => {
    expect(injectLabels(`m{}`, { p: `a\\b` })).toBe(`m{p="a\\\\b"}`);
  });

  test("strips newlines from label values", () => {
    expect(injectLabels(`m{}`, { p: "foo\nbar" })).toBe(`m{p="foobar"}`);
  });

  test("no-op when labels object is empty", () => {
    expect(injectLabels(`metric{job="api"}`, {})).toBe(`metric{job="api"}`);
  });

  test("leaves PromQL without selectors untouched", () => {
    expect(injectLabels("time()", { job: "api" })).toBe("time()");
  });
});

describe("escapePromLabelValue", () => {
  test("escapes backslash first, then double-quote", () => {
    expect(escapePromLabelValue(`a"b\\c`)).toBe(`a\\"b\\\\c`);
  });

  test("strips CR/LF entirely", () => {
    expect(escapePromLabelValue("foo\r\nbar")).toBe("foobar");
  });
});

describe("parseDurationSec", () => {
  const table: Array<[string, number | null]> = [
    ["30s", 30],
    ["15m", 15 * 60],
    ["24h", 24 * 3600],
    ["7d", 7 * 86_400],
    [" 24h ", 24 * 3600],
    ["0s", 0],
    ["24H", null],
    ["1w", null],
    ["abc", null],
    ["24", null],
    ["", null],
  ];
  for (const [input, expected] of table) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(parseDurationSec(input)).toBe(expected);
    });
  }
});

describe("applyDimensionsToSpec", () => {
  function makeSpec(): Spec {
    // Hand-built minimal Spec. Cast to Spec since several fields are only
    // relevant to YAML loading (validate-specs). The shape used by
    // applyDimensionsToSpec is providers[].queries.* and metric_panels[].
    return {
      slug: "x",
      number: "001",
      title: "x",
      subtitle: "x",
      category: "RPCs",
      status: "live",
      metric: "Latency",
      unit: "ms",
      higher_is_better: false,
      abstract: "ok",
      methodology: ["m"],
      findings: [],
      source: "https://example.com",
      providers: [
        {
          slug: "alchemy",
          name: "Alchemy",
          queries: {
            p50: `latency_ms{provider="alchemy"}`,
            success: `success_rate{provider="alchemy"}`,
            regions: [
              { region: "us-east", p50: `latency_ms{provider="alchemy"}` },
            ],
          },
        },
      ],
      metric_panels: [
        {
          id: "cu_24h",
          label: "CU 24h",
          metric: "cu_total",
          label_key: "provider",
          unit: "count",
          higher_is_better: false,
          tab: true,
        },
      ],
    } as unknown as Spec;
  }

  test("injects labels into every provider query (including regions)", () => {
    const out = applyDimensionsToSpec(makeSpec(), { chain: "base" });
    const p = out.providers[0]!.queries!;
    expect(p.p50).toBe(`latency_ms{provider="alchemy",chain="base"}`);
    expect(p.success).toBe(
      `success_rate{provider="alchemy",chain="base"}`,
    );
    expect(p.regions?.[0]?.p50).toBe(
      `latency_ms{provider="alchemy",chain="base"}`,
    );
  });

  test("normalizes bare-metric panels to braced form before injection (no silent chain mixing)", () => {
    const out = applyDimensionsToSpec(makeSpec(), { chain: "solana" });
    expect(out.metric_panels?.[0]?.metric).toBe(`cu_total{chain="solana"}`);
  });

  test("no-op when no dimension labels are active", () => {
    const before = makeSpec();
    const after = applyDimensionsToSpec(before, {});
    expect(after.providers[0]!.queries!.p50).toBe(
      before.providers[0]!.queries!.p50,
    );
    expect(after.metric_panels?.[0]?.metric).toBe(`cu_total{}`);
  });
});
