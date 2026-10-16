import { describe, expect, test } from "bun:test";
import {
  RPC_COST_CURVE_SCHEMA,
  rpcCostCurveProfile,
  rpcCostCurves,
  rpcCostQuoteAt,
  rpcCostRankAt,
  type RpcCostCurveProvider,
} from "@/lib/rpc-cost-curve";

/**
 * The committed artifact is checked against the pricing model in Go, at the
 * three volumes the gauges publish, for every provider and every workload.
 * What is left for this side is the reading: that the interpolation lands
 * where the harness says it should, and that a gap never reads as a price.
 */

const provider = (points: RpcCostCurveProvider["points"]): RpcCostCurveProvider => ({
  slug: "x",
  name: "X",
  cohort: "usage",
  unit: "request",
  points,
});

describe("reading the curve between its points", () => {
  test("interpolates linearly inside a segment", () => {
    const p = provider([
      { r: 10e6, usd: 100, plan: "a" },
      { r: 20e6, usd: 200, plan: "a" },
    ]);
    const q = rpcCostQuoteAt(p, 15e6);
    expect(q.usd).toBeCloseTo(150, 6);
  });

  test("holds a flat run flat, which is what an allowance is", () => {
    // Chainstack Growth: $49 from 100k all the way to 20M, then overage.
    // The three bugs that made this read $83.83 at 10M all came from a
    // straight line drawn across a corner, so the flat case is the one
    // worth pinning on this side too.
    const p = provider([
      { r: 100e3, usd: 49, plan: "growth" },
      { r: 20e6, usd: 49, plan: "growth" },
      { r: 30e6, usd: 199, plan: "growth" },
    ]);
    expect(rpcCostQuoteAt(p, 10e6).usd).toBe(49);
    expect(rpcCostQuoteAt(p, 20e6).usd).toBe(49);
  });

  test("clamps to the nearest end outside the emitted span", () => {
    const p = provider([
      { r: 100e3, usd: 49, plan: "growth" },
      { r: 20e6, usd: 149, plan: "growth" },
    ]);
    expect(rpcCostQuoteAt(p, 1_000).usd).toBe(49);
    expect(rpcCostQuoteAt(p, 10e9).usd).toBe(149);
  });

  test("reports the plan behind the number", () => {
    const p = provider([
      { r: 10e6, usd: 100, plan: "entry" },
      { r: 20e6, usd: 200, plan: "entry" },
    ]);
    const q = rpcCostQuoteAt(p, 12e6);
    expect(q.usd).not.toBeNull();
    if (q.usd !== null) expect(q.plan).toBe("entry");
  });
});

describe("a gap is not a zero", () => {
  test("returns null and the reason where no plan serves", () => {
    const p = provider([
      { r: 100e3, usd: null, why: "price not published (sales-gated)" },
      { r: 5e9, usd: null, why: "price not published (sales-gated)" },
    ]);
    const q = rpcCostQuoteAt(p, 40e6);
    expect(q.usd).toBeNull();
    if (q.usd === null) expect(q.reason).toBe("price not published (sales-gated)");
  });

  test("refuses to draw a line from a price to nothing", () => {
    // The provider stops serving somewhere inside this segment and the
    // emitter could not say where. Half of $100 is not the answer.
    const p = provider([
      { r: 10e6, usd: 100, plan: "a" },
      { r: 20e6, usd: null, why: "above the plan's hard cap" },
    ]);
    expect(rpcCostQuoteAt(p, 15e6).usd).toBeNull();
  });

  test("an empty curve is unpriced, not free", () => {
    expect(rpcCostQuoteAt(provider([]), 10e6).usd).toBeNull();
  });
});

describe("ranking at a volume", () => {
  test("keeps unpriced providers out of the ranking entirely", () => {
    const { priced, unpriced } = rpcCostRankAt("dapp", 10e6);
    expect(priced.length).toBeGreaterThan(0);
    for (const row of priced) expect(row.usd).not.toBeNull();
    for (const row of unpriced) {
      expect(row.usd).toBeNull();
      // Every absence carries its own explanation, so the panel never has
      // to render a blank it cannot account for.
      expect(row.reason.length).toBeGreaterThan(0);
    }
  });

  test("cheapest first", () => {
    const { priced } = rpcCostRankAt("dapp", 100e6);
    const usd = priced.map((r) => r.usd ?? Infinity);
    expect([...usd].sort((a, b) => a - b)).toEqual(usd);
  });

  test("an unknown workload ranks nothing rather than guessing", () => {
    expect(rpcCostRankAt("no-such-profile", 10e6)).toEqual({
      priced: [],
      unpriced: [],
    });
  });
});

describe("the committed artifact", () => {
  const file = rpcCostCurves();

  test("is a shape this build understands", () => {
    expect(file).not.toBeNull();
    expect(file?.schema).toBe(RPC_COST_CURVE_SCHEMA);
  });

  test("carries only the cohorts the leaderboard ranks", () => {
    // `excluded` providers publish no series at all and reference rows are
    // never ranked, so neither belongs on a surface that sorts by price.
    for (const profile of file?.profiles ?? []) {
      for (const p of profile.providers) {
        expect(["usage", "dedicated"]).toContain(p.cohort);
      }
    }
  });

  test("has the dapp workload the panel opens on", () => {
    expect(rpcCostCurveProfile("dapp")).not.toBeNull();
  });

  test("never crowns a one-month trial at the floor", () => {
    // Three catalogue plans cost $0 and do not recur: QuickNode's one-month
    // trial, NOWNodes' one-month Start, Tatum's lifetime 100k credits. All
    // three are banded as paid plans, so the model quoted the $0 and the
    // slider's own floor is where they would have led the board.
    const floor = file?.floor ?? 100e3;
    for (const profile of file?.profiles ?? []) {
      for (const slug of ["quicknode", "nownodes", "tatum"]) {
        const p = profile.providers.find((x) => x.slug === slug);
        if (!p) continue;
        const q = rpcCostQuoteAt(p, floor);
        if (q.usd !== null) expect(q.usd).toBeGreaterThan(0);
      }
    }
  });

  test("keeps a recurring zero, because that one is a price", () => {
    // Validation Cloud's Scale is banded pay-as-you-go with the first 50M
    // CU free: at the floor it genuinely bills nothing, every month.
    const p = rpcCostCurveProfile("dapp")?.providers.find(
      (x) => x.slug === "validation-cloud",
    );
    expect(p).toBeDefined();
    if (p) expect(rpcCostQuoteAt(p, file?.floor ?? 100e3).usd).toBe(0);
  });
});
