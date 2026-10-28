import { describe, expect, test } from "bun:test";
import { REPORT, PROVIDERS, costAt, fmtCount, fmtMs, fmtUsd, httpWins, chainsServed } from "./shared";

describe("private RPC report formatters", () => {
  test("round before choosing a unit", () => {
    expect(fmtMs(99.96)).toBe("100");
    expect(fmtMs(999.6)).toBe("1.0 s");
    expect(fmtMs(7.21)).toBe("7.2");
    expect(fmtUsd(999.6)).toBe("$1k");
    expect(fmtUsd(1049)).toBe("$1.05k");
    expect(fmtUsd(9999.5)).toBe("$10k");
    expect(fmtUsd(12547.5)).toBe("$12.5k");
    expect(fmtCount(999_500)).toBe("1M");
    expect(fmtCount(10_500_000)).toBe("10.5M");
    expect(fmtCount(1.04e9)).toBe("1B");
    expect(fmtCount(1e9)).toBe("1B");
    expect(fmtCount(75_000)).toBe("75k");
  });
});

describe("private RPC report data", () => {
  test("fastest-cell counts cover all 27 cells, with the Arbitrum US East tie shared", () => {
    const wins = Object.fromEntries(PROVIDERS.map((p) => [p.slug, httpWins(p.slug)]));
    expect(wins.quicknode).toEqual({ won: 18, shared: 1 });
    expect(wins.chainstack).toEqual({ won: 5, shared: 1 });
    const outright = PROVIDERS.reduce((a, p) => a + wins[p.slug].won - wins[p.slug].shared, 0);
    expect(outright + 1).toBe(27);
  });

  test("chains served match the plans the report discloses", () => {
    expect(PROVIDERS.map((p) => chainsServed(p.slug))).toEqual([9, 9, 9, 9, 8, 7]);
  });

  test("the dapp bill table in the report body matches the curves", () => {
    const at = (s: string, r: number) => Math.round(costAt(REPORT.cost.dapp[s], r)!);
    expect([1e6, 1e7, 5e7, 1e8, 1e9].map((r) => at("blockmachine", r))).toEqual([9, 25, 115, 125, 999]);
    expect([1e6, 1e7, 5e7, 1e8, 1e9].map((r) => at("quicknode", r))).toEqual([49, 130, 552, 1049, 9999]);
    expect([1e6, 1e7, 5e7, 1e8, 1e9].map((r) => at("chainstack", r))).toEqual([49, 49, 199, 449, 3990]);
  });
});
