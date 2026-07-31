import { describe, expect, test } from "bun:test";
import {
  fmtUnit,
  fmtValue,
  fmtAsOfUtc,
  unitSuffix,
  valueInDeclaredUnit,
} from "./format";

describe("fmtUnit — ms (default latency unit)", () => {
  test("integer ms", () => expect(fmtUnit(150, "ms")).toBe("150 ms"));
  test("zero ms", () => expect(fmtUnit(0, "ms")).toBe("0 ms"));
  test("sub-millisecond keeps one decimal", () => expect(fmtUnit(0.5, "ms")).toBe("0.5 ms"));
  test("auto-flips to s at 1000ms", () => expect(fmtUnit(1000, "ms")).toBe("1.00 s"));
  test("auto-flips to s at 5000ms", () => expect(fmtUnit(5000, "ms")).toBe("5.00 s"));
  test("auto-flips to min at 60000ms", () => expect(fmtUnit(60000, "ms")).toBe("1.0 min"));
  test("auto-flips to min at 120000ms", () => expect(fmtUnit(120000, "ms")).toBe("2.0 min"));
  test("non-finite returns dash", () => expect(fmtUnit(NaN, "ms")).toBe("-"));
  test("Infinity returns dash", () => expect(fmtUnit(Infinity, "ms")).toBe("-"));
});

describe("fmtUnit — s (latency stored as ms, displayed as seconds)", () => {
  test("sub-10s shows one decimal", () => expect(fmtUnit(5000, "s")).toBe("5.0 s"));
  test("0ms edge case", () => expect(fmtUnit(0, "s")).toBe("<1 s"));
  test("exactly 60s flips to min", () => expect(fmtUnit(60_000, "s")).toBe("1.0 min"));
  test("10s+ shows integer", () => expect(fmtUnit(15_000, "s")).toBe("15 s"));
  test("large value in minutes", () => expect(fmtUnit(600_000, "s")).toBe("10.0 min"));
});

describe("fmtUnit — sec (true seconds gauge)", () => {
  test("sub-minute shows seconds", () => expect(fmtUnit(45, "sec")).toBe("45.0 s"));
  test("sub-0.1s shows <0.1 s", () => expect(fmtUnit(0.05, "sec")).toBe("<0.1 s"));
  test("flips to min at 60s", () => expect(fmtUnit(90, "sec")).toBe("1.5 min"));
  test("flips to h at 3600s", () => expect(fmtUnit(7200, "sec")).toBe("2.0 h"));
  test("flips to d at 172800s", () => expect(fmtUnit(172800, "sec")).toBe("2.0 d"));
  test("large hours no decimal", () => expect(fmtUnit(36001, "sec")).toBe("10 h"));
});

describe("fmtUnit — pct", () => {
  test("0%", () => expect(fmtUnit(0, "pct")).toBe("0%"));
  test("large pct one decimal", () => expect(fmtUnit(12.5, "pct")).toBe("12.5%"));
  test("medium pct two decimals", () => expect(fmtUnit(1.5, "pct")).toBe("1.50%"));
  test("small pct three decimals", () => expect(fmtUnit(0.033, "pct")).toBe("0.033%"));
  test("very small pct four decimals", () => expect(fmtUnit(0.005, "pct")).toBe("0.0050%"));
});

describe("fmtUnit — bps (legacy, converts to percent)", () => {
  test("100 bps = 1%", () => expect(fmtUnit(100, "bps")).toBe("1.00%"));
  test("1000 bps = 10%", () => expect(fmtUnit(1000, "bps")).toBe("10.0%"));
});

describe("fmtUnit — bp (basis points as-is)", () => {
  test("0 bps", () => expect(fmtUnit(0, "bp")).toBe("0 bps"));
  test("near-zero shows ~0 bps", () => expect(fmtUnit(0.001, "bp")).toBe("~0 bps"));
  test("small value two decimals", () => expect(fmtUnit(1.5, "bp")).toBe("1.50 bps"));
  test("mid value one decimal", () => expect(fmtUnit(50.5, "bp")).toBe("50.5 bps"));
  test("large value integer", () => expect(fmtUnit(200, "bp")).toBe("200 bps"));
  test("negative value", () => expect(fmtUnit(-0.74, "bp")).toBe("-0.74 bps"));
});

describe("fmtUnit — slots", () => {
  test("0 slots", () => expect(fmtUnit(0, "slots")).toBe("0 slots"));
  test("1.0 slot (singular)", () => expect(fmtUnit(1, "slots")).toBe("1.0 slot"));
  test("2.5 slots", () => expect(fmtUnit(2.5, "slots")).toBe("2.5 slots"));
  test("large integer slots", () => expect(fmtUnit(100, "slots")).toBe("100 slots"));
});

describe("fmtUnit — count", () => {
  test("zero", () => expect(fmtUnit(0, "count")).toBe("0"));
  test("integer count", () => expect(fmtUnit(1234, "count")).toBe("1,234"));
  test("float noise rounded", () => expect(fmtUnit(32.01, "count")).toBe("32"));
  test("near-zero sub-0.01 shows ~0", () => expect(fmtUnit(0.001, "count")).toBe("~0"));
  test("sub-1 shows 3 decimals", () => expect(fmtUnit(0.5, "count")).toBe("0.500"));
  test("10k+ compacts to K", () => expect(fmtUnit(10_000, "count")).toBe("10.0K"));
  test("1M+ compacts to M", () => expect(fmtUnit(1_500_000, "count")).toBe("1.50M"));
  test("1B+ compacts to B", () => expect(fmtUnit(2_000_000_000, "count")).toBe("2.00B"));
});

describe("fmtUnit — usd", () => {
  test("zero", () => expect(fmtUnit(0, "usd")).toBe("$0"));
  test("sub-cent precision", () => expect(fmtUnit(0.005, "usd")).toBe("$0.00500"));
  test("sub-dollar", () => expect(fmtUnit(0.5, "usd")).toBe("$0.5000"));
  test("dollars", () => expect(fmtUnit(12.5, "usd")).toBe("$12.5"));
  test("thousands locale formatted", () => expect(fmtUnit(1_500, "usd")).toBe("$1,500"));
  test("large compact", () => expect(fmtUnit(2_000_000, "usd")).toBe("$2.00M"));
  test("very small exponent", () => {
    const out = fmtUnit(0.0000001, "usd");
    expect(out).toMatch(/^\$.*e/);
  });
});

describe("fmtUnit — gwei", () => {
  test("zero", () => expect(fmtUnit(0, "gwei")).toBe("0 gwei"));
  test("near-zero shows ~0 gwei", () => expect(fmtUnit(1e-10, "gwei")).toBe("~0 gwei"));
  test("sub-1 three decimals", () => expect(fmtUnit(0.5, "gwei")).toBe("0.500 gwei"));
  test("integer gwei", () => expect(fmtUnit(25, "gwei")).toBe("25 gwei"));
  test("large compact", () => expect(fmtUnit(15_000, "gwei")).toBe("15.0K gwei"));
});

describe("valueInDeclaredUnit", () => {
  test("unit s divides by 1000 (ms stored, s declared)", () => {
    expect(valueInDeclaredUnit(5000, "s")).toBe(5);
  });
  test("other units pass through unchanged", () => {
    expect(valueInDeclaredUnit(150, "ms")).toBe(150);
    expect(valueInDeclaredUnit(0.5, "pct")).toBe(0.5);
    expect(valueInDeclaredUnit(100, "usd")).toBe(100);
  });
});

describe("fmtAsOfUtc", () => {
  test("formats a valid ISO string", () => {
    expect(fmtAsOfUtc("2026-07-15T14:30:00.000Z")).toBe("2026-07-15 14:30 UTC");
  });
  test("zero-pads month and day", () => {
    expect(fmtAsOfUtc("2026-01-05T09:05:00.000Z")).toBe("2026-01-05 09:05 UTC");
  });
  test("returns null for invalid input", () => {
    expect(fmtAsOfUtc("not-a-date")).toBeNull();
    expect(fmtAsOfUtc("")).toBeNull();
  });
});

describe("unitSuffix", () => {
  test("pct suffix", () => expect(unitSuffix("pct")).toBe(" %"));
  test("bps suffix", () => expect(unitSuffix("bps")).toBe(" %"));
  test("bp suffix", () => expect(unitSuffix("bp")).toBe(" bps"));
  test("slots suffix", () => expect(unitSuffix("slots")).toBe(" slots"));
  test("count no suffix", () => expect(unitSuffix("count")).toBe(""));
  test("usd no suffix", () => expect(unitSuffix("usd")).toBe(""));
  test("gwei suffix", () => expect(unitSuffix("gwei")).toBe(" gwei"));
  test("ms stays ms below 1000ms", () => expect(unitSuffix("ms", 500)).toBe(" ms"));
  test("ms flips to s at 1000ms", () => expect(unitSuffix("ms", 1000)).toBe(" s"));
  test("ms flips to min at 60000ms", () => expect(unitSuffix("ms", 60000)).toBe(" min"));
  test("s unit flips to min above 60s worth of ms", () => expect(unitSuffix("s", 60_000)).toBe(" min"));
  test("s unit stays s below 60s", () => expect(unitSuffix("s", 5_000)).toBe(" s"));
  test("sec unit stays s below 60", () => expect(unitSuffix("sec", 30)).toBe(" s"));
  test("sec unit flips to min at 60+", () => expect(unitSuffix("sec", 90)).toBe(" min"));
  test("sec unit flips to h at 3600+", () => expect(unitSuffix("sec", 3600)).toBe(" h"));
  test("sec unit flips to d at 172800+", () => expect(unitSuffix("sec", 172800)).toBe(" d"));
  test("unknown unit defaults to ms", () => expect(unitSuffix("whatever")).toBe(" ms"));
});

describe("fmtValue (number only, no unit word)", () => {
  test("strips trailing ms", () => expect(fmtValue(150, "ms")).toBe("150"));
  test("strips trailing s", () => expect(fmtValue(5000, "ms")).toBe("5.00"));
  test("strips trailing min", () => expect(fmtValue(60000, "ms")).toBe("1.0"));
  test("keeps $ prefix for usd", () => expect(fmtValue(100, "usd")).toBe("$100"));
  test("keeps K/M compact notation", () => expect(fmtValue(1_500_000, "count")).toBe("1.50M"));
  test("strips % from pct", () => expect(fmtValue(5, "pct")).toBe("5.00"));
});
