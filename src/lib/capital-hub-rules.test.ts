import { describe, expect, test } from "bun:test";
import {
  CCTP_DOMAIN_CHAINS,
  bridgedShareSubline,
  cctpScope,
  change7dFromDays,
  change7dFromSeries,
  cohortCell,
  fmtUsdLevel,
  isDust,
  levelSortValue,
  median7dPct,
  selectDivergences,
  sevenDaySubline,
} from "./capital-hub-rules";
import { fmtUsdShort } from "./capital-hub-types";

describe("dust levels", () => {
  test("a DeFiLlama zero or a few dollars reads <$1K and sorts as 0; a real level keeps its digits", () => {
    expect(fmtUsdLevel(0)).toBe("<$1K");
    expect(fmtUsdLevel(6)).toBe("<$1K");
    expect(fmtUsdLevel(999.99)).toBe("<$1K");
    expect(fmtUsdLevel(1_000)).toBe("$1K");
    expect(fmtUsdLevel(12_144_042)).toBe("$12.1M");
    expect(fmtUsdLevel(null)).toBe("n/a");
    expect(isDust(6)).toBe(true);
    expect(isDust(1_000)).toBe(false);
    expect(isDust(null)).toBe(false);
    expect(levelSortValue(6)).toBe(0);
    expect(levelSortValue(5_000)).toBe(5_000);
    expect(levelSortValue(null)).toBeNull();
  });

  test("a flow of forty cents prints $0, never -$0", () => {
    expect(fmtUsdShort(-0.4)).toBe("$0");
    expect(fmtUsdShort(-0.6)).toBe("-$1");
    expect(fmtUsdShort(-436_300_000)).toBe("-$436.3M");
  });
});

describe("7d vs L2 median", () => {
  test("the median is the chain's move minus its excess, and the sub-line names both", () => {
    expect(median7dPct(8.7, 4.0)).toBeCloseTo(4.7, 6);
    expect(median7dPct(null, 4.0)).toBeNull();
    expect(median7dPct(8.7, null)).toBeNull();
    expect(sevenDaySubline(8.7, 4.7)).toBe("chain +8.7%, median +4.7%");
    expect(sevenDaySubline(-2.6, median7dPct(-2.6, -0.1))).toBe("chain -2.6%, median -2.5%");
    expect(sevenDaySubline(null, 4.7)).toBeNull();
    expect(sevenDaySubline(8.7, null)).toBeNull();
    expect(sevenDaySubline(8.7, 4.7)).not.toContain("own move");
  });
});

describe("bridged share sub-line", () => {
  test("appears under 90% only", () => {
    expect(bridgedShareSubline(100)).toBeNull();
    expect(bridgedShareSubline(90)).toBeNull();
    expect(bridgedShareSubline(89.6)).toBe("90% bridged");
    expect(bridgedShareSubline(42.4)).toBe("42% bridged");
    expect(bridgedShareSubline(null)).toBeNull();
  });
});

describe("cohort cells", () => {
  test("ranked value inside the cohort, n/a inside without a value", () => {
    expect(cohortCell(true, 202_400_000, null)).toEqual({ kind: "value", value: 202_400_000 });
    // A withheld cohort row: the blob value never stands in for the bench.
    expect(cohortCell(true, null, 5)).toEqual({ kind: "na" });
  });
  test("outside the cohort: the blob value muted, a dash when nothing exists", () => {
    expect(cohortCell(false, null, -320_948.82)).toEqual({ kind: "outside", value: -320_948.82 });
    expect(cohortCell(false, null, null)).toEqual({ kind: "dash" });
    // Outside the cohort there is no ranked value by construction; the blob decides.
    expect(cohortCell(false, 1, null)).toEqual({ kind: "dash" });
  });
});

describe("CCTP scope", () => {
  const scanned = new Set(["ethereum", "base", "arbitrum", "optimism", "polygon", "avalanche", "unichain"]);
  test("scanned sources, unscanned domains, chains with no domain", () => {
    expect(cctpScope("base", scanned)).toBe("scanned");
    expect(cctpScope("solana", scanned)).toBe("domain");
    expect(cctpScope("hyperliquid", scanned)).toBe("domain");
    expect(cctpScope("world-chain", scanned)).toBe("domain");
    expect(cctpScope("tron", scanned)).toBe("none");
    expect(cctpScope("bitcoin", scanned)).toBe("none");
  });
  test("the domain table carries the chains the owner listed", () => {
    for (const s of ["ethereum", "avalanche", "optimism", "arbitrum", "base", "polygon", "unichain", "linea", "sonic", "world-chain", "sei", "ink", "plume", "solana", "sui", "aptos", "hyperliquid"]) {
      expect(CCTP_DOMAIN_CHAINS.has(s)).toBe(true);
    }
  });
  test("with no scanned set at all (bench not loaded) every domain chain is a domain, none is scanned", () => {
    expect(cctpScope("ethereum", new Set())).toBe("domain");
  });
});

describe("divergences", () => {
  const rows = [
    { slug: "a", feeGrowth30dPct: 48, priceChange30dPct: -12, pfVsCategory: 0.07 },
    { slug: "b", feeGrowth30dPct: 166, priceChange30dPct: -38, pfVsCategory: 0.06 },
    { slug: "c", feeGrowth30dPct: 969, priceChange30dPct: 197, pfVsCategory: 0.02 }, // token up
    { slug: "d", feeGrowth30dPct: 263, priceChange30dPct: -43, pfVsCategory: 1.2 }, // above the median
    { slug: "e", feeGrowth30dPct: -4, priceChange30dPct: -10, pfVsCategory: 0.5 }, // fees down
    { slug: "f", feeGrowth30dPct: 25, priceChange30dPct: -20, pfVsCategory: 0.46 },
    { slug: "g", feeGrowth30dPct: 81, priceChange30dPct: -8, pfVsCategory: 0.18 },
    { slug: "h", feeGrowth30dPct: 58, priceChange30dPct: -17, pfVsCategory: 0.05 },
    { slug: "i", feeGrowth30dPct: 6, priceChange30dPct: -1, pfVsCategory: 0.93 },
    { slug: "j", feeGrowth30dPct: null, priceChange30dPct: -1, pfVsCategory: 0.5 },
  ];
  test("all three clauses, top five by fee growth", () => {
    expect(selectDivergences(rows).map((r) => r.slug)).toEqual(["b", "g", "h", "a", "f"]);
  });
  test("empty when no row matches", () => {
    expect(selectDivergences(rows.filter((r) => ["c", "d", "e", "j"].includes(r.slug)))).toEqual([]);
  });
});

describe("7d change", () => {
  test("from daily history: only once the day seven days back exists", () => {
    const days = [
      { day: "2026-09-18", oi: 100 },
      { day: "2026-09-19", oi: 105 },
      { day: "2026-09-25", oi: 120 },
    ];
    expect(change7dFromDays(days, "oi")).toBeCloseTo(20, 6);
    expect(change7dFromDays(days.slice(1), "oi")).toBeNull();
    expect(change7dFromDays([], "oi")).toBeNull();
    expect(change7dFromDays([{ day: "2026-09-25", oi: 120 }], "oi")).toBeNull();
  });
  test("from a bench series: first and last finite buckets, and only when the series covers the window", () => {
    const covered = [100, null, 110, 120, 130, 140, 150, 160];
    expect(change7dFromSeries(covered)).toBeCloseTo(60, 6);
    // A bench that started yesterday: the first finite bucket sits late in the window.
    const late = [null, null, null, null, null, null, 150, 160];
    expect(change7dFromSeries(late)).toBeNull();
    expect(change7dFromSeries(undefined)).toBeNull();
    expect(change7dFromSeries([null, null])).toBeNull();
  });
});
