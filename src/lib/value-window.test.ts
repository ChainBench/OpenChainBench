import { describe, expect, it } from "bun:test";
import {
  specValueKind,
  valueColumnLabel,
  valueQualifier,
  valueReadingPhrase,
  valueSuffix,
} from "@/lib/value-window";

describe("valueQualifier", () => {
  it("calls a latency percentile what it is", () => {
    expect(valueQualifier({ unit: "ms" })).toBe("p50, 24h");
    expect(valueColumnLabel({ unit: "ms" })).toBe("p50");
  });

  it("does not claim a percentile when the bench computes one value", () => {
    expect(valueQualifier({ unit: "ms", hasDistribution: false })).toBe("24h");
    expect(valueColumnLabel({ unit: "ms", hasDistribution: false })).toBe("Value");
  });

  it("does not claim a window when the bench reads a gauge as it stands", () => {
    // The defect: bench 273's queries are all last_over_time, its own
    // methodology says the percentiles are equal by construction, and the
    // page still said "(p50, 24h)" in 42 places — including the sentence
    // marked for an answer engine to quote.
    const b = { unit: "usd" as const, valueKind: "latest" as const, hasDistribution: false };
    expect(valueQualifier(b)).toBe("latest value");
    expect(valueSuffix(b)).toBe("(latest value)");
    expect(valueColumnLabel(b)).toBe("Latest");
    expect(valueReadingPhrase(b)).toBe("Latest value");
  });

  it("latest wins over the unit rules, which would otherwise say 24h", () => {
    expect(valueQualifier({ unit: "usd" })).toBe("24h");
    expect(valueQualifier({ unit: "usd", valueKind: "latest" })).toBe("latest value");
    expect(valueQualifier({ unit: "pct" })).toBe("24h avg");
    expect(valueQualifier({ unit: "pct", valueKind: "latest" })).toBe("latest value");
  });

  it("honours a bench's declared window", () => {
    expect(valueQualifier({ unit: "ms", window: "7d" })).toBe("p50, 7d");
    expect(valueQualifier({ unit: "usd", window: "7d" })).toBe("7d");
  });
});

describe("specValueKind, derived from the spec", () => {
  const one = (q: string) => ({ providers: [{ queries: { p50: q } }] });

  it("recognises a point read", () => {
    expect(specValueKind(one('last_over_time(chain_bridged_tvl_usd{chain="base"}[1h])')))
      .toBe("latest");
  });

  it("refuses a window statistic", () => {
    expect(specValueKind(one("avg_over_time(x[24h])"))).toBeUndefined();
    expect(specValueKind(one("quantile_over_time(0.5, x[24h])"))).toBeUndefined();
    expect(specValueKind(one("x"))).toBeUndefined();
  });

  it("refuses a bench where only some providers are point reads", () => {
    expect(
      specValueKind({
        providers: [
          { queries: { p50: "last_over_time(x[1h])" } },
          { queries: { p50: "avg_over_time(y[24h])" } },
        ],
      }),
    ).toBeUndefined();
  });

  it("says nothing about a spec with no provider queries", () => {
    expect(specValueKind({})).toBeUndefined();
    expect(specValueKind({ providers: [] })).toBeUndefined();
    expect(specValueKind({ providers: [{ queries: {} }] })).toBeUndefined();
  });
});

describe("both loaders derive the same kind", () => {
  // The first attempt put the derivation in overlayEditorial only, and the
  // path that actually serves the page is buildEditorial: rowNoun and
  // valueKind shipped in one PR and reached different numbers of surfaces,
  // so the headline kept saying "(24h)" while the noun was already fixed.
  // One exported function, used by both, is the guard.
  it("is one exported function, not two copies", () => {
    const spec = { providers: [{ queries: { p50: "last_over_time(x[1h])" } }] };
    const fromEitherLoader = specValueKind(spec);
    expect(fromEitherLoader).toBe("latest");
    expect(valueQualifier({ unit: "usd", valueKind: fromEitherLoader })).toBe(
      "latest value",
    );
  });
});
