import { describe, expect, test } from "bun:test";
import {
  computeCostModel,
  crossoverMove,
  feeLegFraction,
  gainsStandardThresholdPct,
  isOpenAt,
  LEVERAGE_RANGE,
  type Market,
  maxLeverageOn,
  papertradeKeep,
  unavailableReason,
  VENUES,
} from "@/lib/perp-cost-model";

const MARKETS: Market[] = ["BTC", "ETH"];

// A calculator fails quietly: a negative net rendered as a gain, a liquidation
// distance that goes negative past a venue's own maximum, a crowned row that
// actually loses money. These assert what must hold rather than eyeball it.

describe("papertradeKeep", () => {
  test("it is a fraction on every move, and zero at or below the deadband", () => {
    for (const market of MARKETS) {
      for (const move of [0, 1e-9, 2e-5, 2.1e-5, 1e-4, 1e-3, 0.01, 0.5, 1, 10]) {
        const keep = papertradeKeep(market, move);
        expect(Number.isFinite(keep)).toBe(true);
        expect(keep).toBeGreaterThanOrEqual(0);
        expect(keep).toBeLessThanOrEqual(0.9 * 0.98);
      }
      expect(papertradeKeep(market, 1e-6)).toBe(0);
    }
  });

  // The bisection in crossoverMove() is only sound because of this.
  test("it rises with the move and never falls", () => {
    for (const market of MARKETS) {
      let previous = -1;
      for (let move = 1e-4; move <= 0.5; move *= 1.15) {
        const keep = papertradeKeep(market, move);
        expect(keep).toBeGreaterThanOrEqual(previous);
        previous = keep;
      }
    }
  });

  test("it approaches one minus the base rate and the win fee, from below", () => {
    const ceiling = 0.9 * 0.98;
    expect(papertradeKeep("BTC", 100)).toBeLessThan(ceiling);
    expect(papertradeKeep("BTC", 100)).toBeCloseTo(ceiling, 4);
  });
});

describe("gainsStandardThresholdPct", () => {
  test("it stays inside the two thresholds the contract publishes", () => {
    for (const lev of [1, 1.1, 24.9, 25, 42.5, 60, 60.1, 200, 1e6]) {
      const threshold = gainsStandardThresholdPct(lev);
      expect(threshold).toBeLessThanOrEqual(90);
      expect(threshold).toBeGreaterThanOrEqual(75);
    }
  });

  test("it is flat outside the interpolated band and linear inside it", () => {
    expect(gainsStandardThresholdPct(1)).toBe(90);
    expect(gainsStandardThresholdPct(25)).toBe(90);
    expect(gainsStandardThresholdPct(60)).toBe(75);
    expect(gainsStandardThresholdPct(1e6)).toBe(75);
    expect(gainsStandardThresholdPct(42.5)).toBeCloseTo(82.5, 9);
  });
});

describe("every venue holds across its whole leverage range", () => {
  for (const market of MARKETS) {
    for (const venue of VENUES) {
      test(`${venue.id} on ${market}`, () => {
        const mx = maxLeverageOn(venue, market);
        expect(mx).toBeGreaterThan(0);
        expect(venue.minLeverage).toBeGreaterThan(0);
        expect(venue.minLeverage).toBeLessThanOrEqual(mx);

        const legFee = feeLegFraction(venue, market);
        expect(legFee).toBeGreaterThanOrEqual(0);
        expect(legFee).toBeLessThan(0.01);

        // An implied cap is approached and not offered, so the boundary itself
        // sits outside the range and must not be asserted on.
        const top = venue.impliedCap ? mx * (1 - 1e-6) : mx;
        const step = Math.max((top - venue.minLeverage) / 200, 0.05);
        for (let lev = venue.minLeverage; lev <= top; lev += step) {
          const row = computeCostModel({ margin: 1000, leverage: lev, market, move: 0.002 }).live.find(
            (r) => r.venue.id === venue.id,
          );
          expect(row, `${venue.id} must be open at ${lev}x`).toBeDefined();
          expect(row!.roomPct).not.toBeNull();
          expect(row!.roomPct!).toBeGreaterThan(0);
          expect(row!.roomPct!).toBeLessThanOrEqual(100);
          expect(row!.equityLeftPct).toBeGreaterThanOrEqual(0);
          expect(row!.equityLeftPct).toBeLessThanOrEqual(1);
          expect(Number.isFinite(row!.cost)).toBe(true);
        }
      });
    }
  }
});

describe("isOpenAt", () => {
  test("a published cap includes its boundary and an implied one excludes it", () => {
    const gmx = VENUES.find((v) => v.id === "gmx")!;
    const dydx = VENUES.find((v) => v.id === "dydx")!;
    expect(isOpenAt(gmx, "BTC", 199.9)).toBe(true);
    expect(isOpenAt(gmx, "BTC", 200)).toBe(false);
    expect(isOpenAt(dydx, "BTC", 50)).toBe(true);
    expect(isOpenAt(dydx, "BTC", 50.1)).toBe(false);
  });

  test("a fixed leverage product is open at exactly one leverage", () => {
    const degen = VENUES.find((v) => v.id === "gains-degen")!;
    expect(isOpenAt(degen, "BTC", 499)).toBe(false);
    expect(isOpenAt(degen, "BTC", 500)).toBe(true);
    expect(isOpenAt(degen, "BTC", 501)).toBe(false);
  });
});

describe("unavailableReason", () => {
  // Reading the minimum first printed "fixed at 1.1x" for a standard Gains
  // pair at 500x, where the real reason is its 200x cap.
  test("it names the bound that was actually crossed", () => {
    const at500 = computeCostModel({ margin: 1000, leverage: 500, market: "BTC", move: 0.002 });
    const reasons = new Map(
      at500.unavailable.map((r) => [r.venue.id, unavailableReason(r, 500)]),
    );
    expect(reasons.get("gains-std")).toBe("caps at 200x");
    expect(reasons.get("gmx")).toContain("bites below 200x");

    const at10 = computeCostModel({ margin: 1000, leverage: 10, market: "BTC", move: 0.002 });
    const low = new Map(at10.unavailable.map((r) => [r.venue.id, unavailableReason(r, 10)]));
    expect(low.get("gains-degen")).toBe("fixed at 500x");
  });
});

describe("the crossover", () => {
  test("it does not move with the margin or the leverage, only the move", () => {
    const rival = VENUES.find((v) => v.id === "gains-degen")!;
    const direct = crossoverMove("BTC", feeLegFraction(rival, "BTC"));
    for (const margin of [1, 1000, 1e6]) {
      const model = computeCostModel({ margin, leverage: 500, market: "BTC", move: 0.002 });
      expect(model.rival?.venue.id).toBe("gains-degen");
      expect(model.crossoverMove!).toBeCloseTo(direct, 12);
    }
  });

  test("the cheaper venue flips exactly once around it", () => {
    const market: Market = "BTC";
    const rival = VENUES.find((v) => v.id === "gains-degen")!;
    const legFee = feeLegFraction(rival, market);
    let flips = 0;
    let previous: string | null = null;
    for (let move = 2e-5; move < 0.05; move *= 1.02) {
      const cheaper = move * (1 - papertradeKeep(market, move)) < 2 * legFee ? "pt" : "rival";
      if (previous && cheaper !== previous) flips += 1;
      previous = cheaper;
    }
    expect(flips).toBe(1);
  });

  test("it is null when Papertrade has no notional-fee venue to cross", () => {
    // Between 201x and 1000x, 500x aside, Papertrade is the only venue open.
    const model = computeCostModel({ margin: 1000, leverage: 300, market: "BTC", move: 0.002 });
    expect(model.live.map((r) => r.venue.id)).toEqual(["papertrade"]);
    expect(model.rival).toBeNull();
    expect(model.crossoverMove).toBeNull();
  });
});

describe("computeCostModel", () => {
  // Checked against the figures the Python harness produced off chain.
  test("the reference position reproduces the measured values", () => {
    const model = computeCostModel({ margin: 1000, leverage: 500, market: "BTC", move: 0.002 });
    const degen = model.live.find((r) => r.venue.id === "gains-degen")!;
    const papertrade = model.live.find((r) => r.venue.id === "papertrade")!;

    expect(degen.cost).toBeCloseTo(200, 6);
    expect(degen.flatCost).toBeCloseTo(200, 6);
    expect(degen.roomPct!).toBeCloseTo(0.12, 6);
    expect(papertrade.roomPct!).toBeCloseTo(0.1524, 4);
    expect(papertrade.flatCost).toBe(0);
  });

  test("the sort is cheapest first and the two sets partition the venues", () => {
    for (const market of MARKETS) {
      for (const leverage of [1, 10, 40, 50, 200, 300, 500, 1000]) {
        const model = computeCostModel({ margin: 1000, leverage, market, move: 0.002 });
        expect(model.live.length + model.unavailable.length).toBe(VENUES.length);
        for (let i = 1; i < model.live.length; i += 1) {
          expect(model.live[i].cost).toBeGreaterThanOrEqual(model.live[i - 1].cost - 1e-9);
        }
        if (model.live.length > 0) expect(model.cheapest).toBe(model.live[0]);
        if (model.live.length <= 1) expect(model.dearest).toBeNull();
      }
    }
  });

  // At the bottom of the slider the fees exceed the gain on every venue. The
  // table used to crown the first row green regardless.
  test("it reports that nothing is profitable when the fees exceed the gain", () => {
    const model = computeCostModel({ margin: 1000, leverage: 50, market: "BTC", move: 1e-5 });
    expect(model.anyProfitable).toBe(false);
    expect(model.cheapest!.net).toBeLessThanOrEqual(0);
    expect(model.live.some((r) => r.shareOfGain > 1)).toBe(true);
  });

  test("a sub-deadband win on Papertrade nets zero rather than a negative", () => {
    const model = computeCostModel({ margin: 1000, leverage: 500, market: "BTC", move: 1e-6 });
    const papertrade = model.live.find((r) => r.venue.id === "papertrade")!;
    expect(papertrade.net).toBe(0);
    expect(papertrade.cost).toBeCloseTo(model.rawGain, 12);
  });

  test("no figure reaches NaN or Infinity at the edges of the accepted inputs", () => {
    const corners = [
      { margin: 1, leverage: LEVERAGE_RANGE.min },
      { margin: 1, leverage: LEVERAGE_RANGE.max },
      { margin: 1e9, leverage: LEVERAGE_RANGE.min },
      { margin: 1e9, leverage: LEVERAGE_RANGE.max },
    ];
    for (const market of MARKETS) {
      for (const { margin, leverage } of corners) {
        for (const move of [1e-5, 0.02]) {
          const model = computeCostModel({ margin, leverage, market, move });
          for (const row of [...model.live, ...model.unavailable]) {
            for (const n of [row.cost, row.net, row.shareOfGain, row.equityLeftPct, row.flatCost]) {
              expect(Number.isFinite(n)).toBe(true);
            }
            if (row.roomPct !== null) expect(Number.isFinite(row.roomPct)).toBe(true);
          }
        }
      }
    }
  });
});
