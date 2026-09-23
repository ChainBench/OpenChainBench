import { describe, expect, it } from "bun:test";
import {
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

describe("valueQualifier: window totals", () => {
  it("a window average scaled to the window is a total, not an average", () => {
    expect(valueQualifier({ unit: "bp", valueKind: "total", window: "30d" })).toBe("30 days at the average daily rate");
    expect(valueSuffix({ unit: "bp", valueKind: "total", window: "7d" })).toBe("(7 days at the average daily rate)");
    expect(valueColumnLabel({ unit: "bp", valueKind: "total" })).toBe("Total");
  });
});
