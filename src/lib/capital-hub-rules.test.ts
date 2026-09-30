import { describe, expect, test } from "bun:test";
import {
  CCTP_DOMAIN_CHAINS,
  CCTP_SCOPE_LABEL,
  NA_REASON,
  SIGNAL_FEE_GROWTH_MIN_PCT,
  SIGNAL_MIN_CATEGORY_MEMBERS,
  SIGNAL_PRICE_MOVE_MIN_PCT,
  SIGNAL_READING,
  bridgedShareSubline,
  cctpScope,
  categoryMedianUsable,
  change7dOfSeries,
  cohortCell,
  fmtUsdLevel,
  naLegend,
  naMarker,
  plainCell,
  printedValue,
  signalOf,
  signalRowNote,
  isDust,
  levelSortValue,
  median7dPct,
  perpOiRows,
  selectDivergences,
  sevenDaySubline,
  columnIsWorthShowing,
  sectionState,
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
    // Would print "90%": stays out like 90 itself.
    expect(bridgedShareSubline(89.6)).toBeNull();
    expect(bridgedShareSubline(89.4)).toBe("89% bridged");
    expect(bridgedShareSubline(42.4)).toBe("42% bridged");
    expect(bridgedShareSubline(null)).toBeNull();
  });
});

describe("the four cell states", () => {
  test("ranked value inside the cohort; inside without a value is unknown, never not applicable", () => {
    expect(cohortCell(true, 202_400_000, null)).toEqual({ kind: "value", value: 202_400_000 });
    // A withheld cohort row: the blob value never stands in for the bench, and
    // the cell reads unknown (a bare dash), not "does not apply".
    expect(cohortCell(true, null, 5, NA_REASON.feesNone)).toEqual({ kind: "unknown" });
  });
  test("outside the cohort: the blob value muted, the reason when nothing exists, unknown when there is no reason", () => {
    expect(cohortCell(false, null, -320_948.82)).toEqual({ kind: "outside", value: -320_948.82 });
    expect(cohortCell(false, null, null, NA_REASON.feesNone)).toEqual({ kind: "na", reason: NA_REASON.feesNone });
    // No reason computed: the hub does not know why, so the cell must not claim inapplicability.
    expect(cohortCell(false, null, null)).toEqual({ kind: "unknown" });
    // Outside the cohort there is no ranked value by construction; the blob decides.
    expect(cohortCell(false, 1, null, NA_REASON.feesNone)).toEqual({ kind: "na", reason: NA_REASON.feesNone });
  });
  test("plainCell: a value, else the reason, else unknown", () => {
    expect(plainCell(2.5, NA_REASON.perpTurnoverNone)).toEqual({ kind: "value", value: 2.5 });
    expect(plainCell(null, NA_REASON.perpTurnoverNone)).toEqual({ kind: "na", reason: NA_REASON.perpTurnoverNone });
    expect(plainCell(null, null)).toEqual({ kind: "unknown" });
    expect(plainCell(Number.NaN, null)).toEqual({ kind: "unknown" });
  });
  test("the legend numbers each distinct reason once, in first-seen order", () => {
    const legend = naLegend([NA_REASON.bridgedSource, null, NA_REASON.bridgedSovereign, NA_REASON.bridgedSource, undefined, NA_REASON.feesNone]);
    expect(legend).toEqual([
      { marker: "a", reason: NA_REASON.bridgedSource },
      { marker: "b", reason: NA_REASON.bridgedSovereign },
      { marker: "c", reason: NA_REASON.feesNone },
    ]);
    expect(naMarker(legend, NA_REASON.bridgedSovereign)).toBe("b");
    // A reason the legend does not carry still prints a marker rather than nothing.
    expect(naMarker(legend, NA_REASON.cctpNone)).toBe("*");
    expect(naLegend([])).toEqual([]);
  });
  test("every CCTP scope off the scanned set has a not-applicable reason of its own", () => {
    expect(CCTP_SCOPE_LABEL.none).toBe(NA_REASON.cctpNone);
    expect(CCTP_SCOPE_LABEL.domain).toBe(NA_REASON.cctpUnscanned);
    expect(CCTP_SCOPE_LABEL.none).not.toBe(CCTP_SCOPE_LABEL.domain);
  });
});

describe("signal readings", () => {
  test("both signals carry all three parts and no recommendation", () => {
    const banned = ["buy", "sell", "undervalued", "overvalued", "opportunity", "cheap", "expensive"];
    for (const k of ["fees-up-token-down", "fees-down-token-up"] as const) {
      const r = SIGNAL_READING[k];
      expect(r.means.length).toBeGreaterThan(40);
      expect(r.falsifies.length).toBeGreaterThan(40);
      expect(r.next.length).toBeGreaterThan(40);
      const all = `${r.title} ${r.means} ${r.falsifies} ${r.next}`.toLowerCase();
      for (const w of banned) expect(all.includes(w)).toBe(false);
      // No em-dash anywhere in the prose the page prints.
      expect(all.includes("\u2014")).toBe(false);
    }
  });
  test("the per-row note restates the row's own three numbers and the falsifier; no signal, no note", () => {
    const note = signalRowNote({ signal: "fees-up-token-down", feeGrowth30dPct: 263, priceChange30dPct: -20, pfVsCategory: 0.39, category: "Lending" });
    expect(note).toContain("+263%");
    expect(note).toContain("-20%");
    expect(note).toContain("0.390x");
    expect(note).toContain("Lending");
    expect(note).toContain("incentive program");
    const mirror = signalRowNote({ signal: "fees-down-token-up", feeGrowth30dPct: -12, priceChange30dPct: 30, pfVsCategory: 2.4, category: "DEXs" });
    expect(mirror).toContain("adapter");
    expect(signalRowNote({ signal: null, feeGrowth30dPct: 1, priceChange30dPct: 1, pfVsCategory: 1, category: "DEXs" })).toBeNull();
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
  // Every row sits in a category large enough for its median to count unless
  // the test says otherwise; the category floor has its own test below.
  const rows: { slug: string; feeGrowth30dPct: number | null; priceChange30dPct: number; pfVsCategory: number; categorySize: number }[] = [
    { slug: "a", feeGrowth30dPct: 48, priceChange30dPct: -12, pfVsCategory: 0.07, categorySize: 15 },
    { slug: "b", feeGrowth30dPct: 166, priceChange30dPct: -38, pfVsCategory: 0.06, categorySize: 18 },
    { slug: "c", feeGrowth30dPct: 969, priceChange30dPct: 197, pfVsCategory: 0.02, categorySize: 9 }, // token up
    { slug: "d", feeGrowth30dPct: 263, priceChange30dPct: -43, pfVsCategory: 1.2, categorySize: 8 }, // above the median
    { slug: "e", feeGrowth30dPct: -4, priceChange30dPct: -10, pfVsCategory: 0.5, categorySize: 6 }, // fees down
    { slug: "f", feeGrowth30dPct: 25, priceChange30dPct: -20, pfVsCategory: 0.46, categorySize: 6 },
    { slug: "g", feeGrowth30dPct: 81, priceChange30dPct: -8, pfVsCategory: 0.18, categorySize: 15 }, // token flat: inside the 10% band
    { slug: "h", feeGrowth30dPct: 58, priceChange30dPct: -17, pfVsCategory: 0.05, categorySize: 5 },
    { slug: "i", feeGrowth30dPct: 6, priceChange30dPct: -1, pfVsCategory: 0.93, categorySize: 18 },
    { slug: "j", feeGrowth30dPct: null, priceChange30dPct: -1, pfVsCategory: 0.5, categorySize: 18 },
    { slug: "k", feeGrowth30dPct: 92, priceChange30dPct: -19, pfVsCategory: 0.36, categorySize: 2 }, // Convex: a median over one other protocol
  ];
  test("all four clauses, largest fee growth first", () => {
    expect(selectDivergences(rows).map((r) => r.slug)).toEqual(["b", "h", "a", "f"]);
  });
  test("a flat token does not count as a falling token", () => {
    // g moves -8% over 30 days, inside the band 30% of the cohort sits in.
    expect(signalOf(rows.find((r) => r.slug === "g")!)).toBeNull();
    expect(signalOf({ ...rows.find((r) => r.slug === "g")!, priceChange30dPct: -SIGNAL_PRICE_MOVE_MIN_PCT })).toBeNull();
    expect(signalOf({ ...rows.find((r) => r.slug === "g")!, priceChange30dPct: -10.1 })).toBe("fees-up-token-down");
  });
  test("fee growth at or under the cohort median does not qualify a row", () => {
    const row = rows.find((r) => r.slug === "a")!;
    expect(signalOf({ ...row, feeGrowth30dPct: SIGNAL_FEE_GROWTH_MIN_PCT })).toBeNull();
    expect(signalOf({ ...row, feeGrowth30dPct: 20.1 })).toBe("fees-up-token-down");
  });
  test("a category under five members cannot qualify a row through its median", () => {
    expect(categoryMedianUsable(SIGNAL_MIN_CATEGORY_MEMBERS)).toBe(true);
    expect(categoryMedianUsable(SIGNAL_MIN_CATEGORY_MEMBERS - 1)).toBe(false);
    // k clears both legs and sits under its median; only the category stops it.
    const k = rows.find((r) => r.slug === "k")!;
    expect(signalOf(k)).toBeNull();
    expect(signalOf({ ...k, categorySize: 5 })).toBe("fees-up-token-down");
  });
  test("the mirror signal is symmetric on both legs", () => {
    const base = { pfVsCategory: 3.3, categorySize: 18 };
    expect(signalOf({ ...base, feeGrowth30dPct: -53, priceChange30dPct: 31 })).toBe("fees-down-token-up");
    // Curve: fees -16.7% is inside the band, so the row no longer carries the badge.
    expect(signalOf({ ...base, feeGrowth30dPct: -16.7, priceChange30dPct: 24.5 })).toBeNull();
    expect(signalOf({ ...base, feeGrowth30dPct: -53, priceChange30dPct: 9 })).toBeNull();
  });
  test("empty when no row matches", () => {
    expect(selectDivergences(rows.filter((r) => ["c", "d", "e", "j", "k"].includes(r.slug)))).toEqual([]);
  });
});

describe("7d change", () => {
  test("from a bench series: first and last finite buckets, and only when the series covers the whole window", () => {
    const covered = [100, null, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200];
    expect(change7dOfSeries(covered).value).toBeCloseTo(100, 6);
    // A bench that started this week: the first finite bucket sits past the first tenth of the window.
    const late = [null, null, null, null, null, null, 150, 160, 170, 180, 190, 200];
    expect(change7dOfSeries(late).value).toBeNull();
    // About 75% coverage is not seven days either.
    const threeQuarters = Array.from({ length: 84 }, (_, i) => (i < 21 ? null : 100 + i));
    expect(change7dOfSeries(threeQuarters).value).toBeNull();
    // A step of more than 2x between two adjacent buckets is a change in what the bench
    // measures (Kalshi's open interest went from $71M to $1.02B in one bucket this week): no 7d figure.
    const step = Array.from({ length: 84 }, (_, i) => (i < 40 ? 71_000_000 + i * 10_000 : 1_010_000_000 + i * 10_000));
    expect(change7dOfSeries(step).value).toBeNull();
    // A large but continuous move stays: +80% over the week in small increments.
    const steady = Array.from({ length: 84 }, (_, i) => 100 * (1 + (0.8 * i) / 83));
    expect(change7dOfSeries(steady).value).toBeCloseTo(80, 6);
    expect(change7dOfSeries(undefined).value).toBeNull();
    expect(change7dOfSeries([null, null]).value).toBeNull();
  });
  test("an empty 7d cell says which condition failed, so the table never prints a bare dash for a known reason", () => {
    expect(change7dOfSeries(undefined).naReason).toBe(NA_REASON.oiSeriesMissing);
    expect(change7dOfSeries(Array.from({ length: 84 }, () => null)).naReason).toBe(NA_REASON.oiSeriesMissing);
    // The eleven prediction-market venues whose series starts 11 buckets into
    // an 85-bucket window: a warm-up, not a missing feed.
    const warmup = Array.from({ length: 85 }, (_, i) => (i < 11 ? null : 100 + i));
    expect(change7dOfSeries(warmup)).toEqual({ value: null, naReason: NA_REASON.oiSeriesShort });
    // Kalshi: one bucket goes from $75M to $1.0B, a change in what the venue reports.
    const step = Array.from({ length: 84 }, (_, i) => (i < 13 ? 75_000_000 : 1_000_000_000));
    expect(change7dOfSeries(step)).toEqual({ value: null, naReason: NA_REASON.oiSeriesStep });
    // One reading inside the window is not a move.
    const single = Array.from({ length: 84 }, (_, i) => (i === 0 ? 100 : null));
    expect(change7dOfSeries(single)).toEqual({ value: null, naReason: NA_REASON.oiSeriesFlat });
    expect(change7dOfSeries(Array.from({ length: 84 }, (_, i) => 100 + i)).naReason).toBeNull();
  });
});

describe("perp open interest rows", () => {
  const venues = [
    { slug: "hyperliquid", name: "Hyperliquid", venueType: "onchain" as const, openInterest: 12.77e9, volume24h: 6.61e9 },
    { slug: "trade-xyz", name: "trade.xyz", venueType: "onchain" as const, openInterest: 3.76e9, volume24h: 2.19e9 },
    { slug: "ondo", name: "Ondo Perps", venueType: "onchain" as const, openInterest: 88.6e6, volume24h: 126e6 },
    { slug: "gmx-v2", name: "GMX v2", venueType: "onchain" as const, openInterest: 51.5e6, volume24h: 54.8e6 },
    // The harness gets no open interest from these: a row with a reason, not a dropped row.
    { slug: "orderly", name: "Orderly", venueType: "onchain" as const, openInterest: null, volume24h: 63.6e6 },
    { slug: "backpack", name: "Backpack", venueType: "onchain" as const, openInterest: null, volume24h: 197.4e6 },
    { slug: "kalshi", name: "Kalshi", venueType: "regulated" as const, openInterest: 36.8e6, volume24h: 1.08e9 },
    { slug: "polymarket", name: "Polymarket", venueType: "onchain" as const, openInterest: 75.3e6, volume24h: 72e6 },
    { slug: "binance", name: "Binance", venueType: "cex" as const, openInterest: 20e9, volume24h: 40e9 },
  ];
  const productSlug = (s: string) => (s === "gmx-v2" ? "gmx" : s === "trade-xyz" ? "xyz" : s);
  const build = (turnover: [string, number][], loaded = true) =>
    perpOiRows(venues, {
      productSlug,
      turnoverBy: new Map<string, number | null>(turnover),
      exclude: new Set(["polymarket", "kalshi"]),
      turnoverBenchLoaded: loaded,
    });

  test("centralised venues are out, prediction-market venues are out, everything else keeps a row", () => {
    const rows = build([]);
    expect(rows.map((r) => r.slug)).toEqual(["hyperliquid", "xyz", "ondo", "gmx", "orderly", "backpack"]);
    // Ondo was in the gauge and off the page; it ranks third here on its own open interest.
    expect(rows[2].oi).toBe(88.6e6);
    expect(rows.some((r) => r.slug === "binance")).toBe(false);
    expect(rows.some((r) => r.slug === "polymarket" || r.slug === "kalshi")).toBe(false);
  });
  test("a venue with no open interest keeps its row, ranked last, with the reason on the cell", () => {
    const rows = build([]);
    const orderly = rows.find((r) => r.slug === "orderly")!;
    expect(orderly.oi).toBeNull();
    expect(orderly.oiNaReason).toBe(NA_REASON.perpOiNone);
    // Its volume is real, so that cell carries no reason.
    expect(orderly.volume24h).toBe(63.6e6);
    expect(orderly.volumeNaReason).toBeNull();
    expect(rows.slice(-2).every((r) => r.oi == null)).toBe(true);
    expect(plainCell(orderly.oi, orderly.oiNaReason)).toEqual({ kind: "na", reason: NA_REASON.perpOiNone });
  });
  test("turnover joins on the product slug, and a missing one is unknown when the bench did not load", () => {
    // Bench 271 keys GMX as gmx-v2 and the join goes through the product slug.
    const withTurnover = build([["gmx", 1.07]]);
    expect(withTurnover.find((r) => r.slug === "gmx")!.turnover).toBeCloseTo(1.07, 6);
    expect(withTurnover.find((r) => r.slug === "hyperliquid")!.turnoverNaReason).toBe(NA_REASON.perpTurnoverNone);
    expect(build([], false).every((r) => r.turnoverNaReason === null)).toBe(true);
  });
  test("no 7d column is offered: the level and a 7-day move would come from two measurements", () => {
    const rows = build([]);
    expect(rows.every((r) => r.change7dPct === null && r.change7dNaReason === NA_REASON.perpOiNoSeries)).toBe(true);
    // Zero coverage, so the column does not render at all rather than fill with markers.
    expect(columnIsWorthShowing(rows, (r) => r.change7dPct)).toBe(false);
    expect(columnIsWorthShowing(rows, (r) => r.volume24h)).toBe(true);
  });
  test("an unreachable cohort snapshot yields no rows rather than a table from another source", () => {
    expect(build.length >= 0).toBe(true);
    expect(perpOiRows([], { productSlug, turnoverBy: new Map(), exclude: new Set(), turnoverBenchLoaded: true })).toEqual([]);
  });
});

describe("columnIsWorthShowing", () => {
  test("a column filled for a handful of rows stays hidden, one covering half the cohort shows", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ v: i < 2 ? 1 : null }));
    expect(columnIsWorthShowing(rows, (r) => r.v)).toBe(false);
    const half = Array.from({ length: 10 }, (_, i) => ({ v: i < 5 ? 1 : null }));
    expect(columnIsWorthShowing(half, (r) => r.v)).toBe(true);
    expect(columnIsWorthShowing([], (r: { v: number | null }) => r.v)).toBe(false);
  });
  test("a cohort column counts its muted out-of-cohort values, so 38 ranked plus 20 muted of 63 is a full column", () => {
    // The chain fees column: ranked on the bench's 38, the daily history's
    // value on 20 more, nothing on 5. A null check on the ranked field alone
    // would read 38/63 and drop a column that covers 92% of the rows.
    const rows = Array.from({ length: 63 }, (_, i) => ({
      ranked: i < 38 ? 1e6 : null,
      outside: i >= 38 && i < 58 ? 2e6 : null,
    }));
    expect(columnIsWorthShowing(rows, (r) => r.ranked)).toBe(true);
    expect(columnIsWorthShowing(rows, (r) => printedValue(r.ranked, r.outside))).toBe(true);
    expect(rows.filter((r) => printedValue(r.ranked, r.outside) != null).length).toBe(58);
    // Net USDC over CCTP: 7 of 63, no muted fallback. Not a column.
    const cctp = Array.from({ length: 63 }, (_, i) => ({ ranked: i < 7 ? 1e6 : null, outside: null }));
    expect(columnIsWorthShowing(cctp, (r) => printedValue(r.ranked, r.outside))).toBe(false);
  });
  test("printedValue takes the ranked value first, then the muted one, then nothing", () => {
    expect(printedValue(5, 9)).toBe(5);
    expect(printedValue(null, 9)).toBe(9);
    expect(printedValue(null, null)).toBeNull();
    expect(printedValue(Number.NaN, 9)).toBe(9);
    expect(printedValue(0, 9)).toBe(0);
  });
});

describe("sectionState", () => {
  const B = (over: Partial<{ slug: string; live: boolean; failed: boolean }> = {}) => ({
    slug: "protocol-pf-ratio",
    live: true,
    failed: false,
    ...over,
  });

  test("a section with rows is not missing, whatever the bench says", () => {
    expect(sectionState([B({ failed: true, live: false })], "protocol-pf-ratio", 67)).toBeNull();
    expect(sectionState([B()], "protocol-pf-ratio", 1)).toBeNull();
  });

  test("the three kinds of nothing are told apart, because they mean different things", () => {
    // Transient: the load threw. The reading exists, this render did not get it.
    expect(sectionState([B({ failed: true, live: false })], "protocol-pf-ratio", 0)).toBe("failed");
    // Not served here: a gated bench on a deployment that does not carry it.
    expect(sectionState([B({ live: false })], "protocol-pf-ratio", 0)).toBe("unserved");
    // Served, ran, ranked nobody. The only one of the three that is a measurement.
    expect(sectionState([B()], "protocol-pf-ratio", 0)).toBe("empty");
  });

  test("a bench the deployment never listed stays silent, so a gated reading is not reported as missing", () => {
    // Benches 280 and 281 are only in the list where they are served; without
    // this the hub would print a "unavailable" note on prod for a reading it
    // never promised.
    expect(sectionState([B()], "usdc-corridor-flows", 0)).toBeNull();
    expect(sectionState([], "chain-fees-revenue", 0)).toBeNull();
  });

  test("failed wins over live, so a bench that threw never reads as merely unserved", () => {
    expect(sectionState([B({ live: true, failed: true })], "protocol-pf-ratio", 0)).toBe("failed");
  });
});
