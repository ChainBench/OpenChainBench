import { describe, expect, test } from "bun:test";
import {
  feeLegFraction,
  gainsStandardThresholdPct,
  MEASURED_AT,
  maxLeverageOn,
  VENUES,
  type Market,
} from "./perp-cost-model";

/**
 * Nova runs the same gTrade contract as Gains at a different address, which
 * makes it the one pair of rows in this file where copying a neighbour's value
 * would look right and be wrong.
 *
 * It nearly was. Word 7 of pairs() is the pair spread at 1e10: it reads
 * 100000000 on Gains, so 1.0 bps, and 0 on Nova. Taking Gains' 1.0 would have
 * put Nova at 5.5 bps a leg instead of 5.0, overstating it by 10% while
 * looking entirely plausible next to the identical thresholds.
 *
 * Every figure here was read on chain on 2026-10-22 and is printed by
 * TestGtradeLeverageTermsLive in the perp-cohort-stats harness.
 */

const byId = (id: string) => {
  const v = VENUES.find((x) => x.id === id);
  if (!v) throw new Error(`no venue ${id}`);
  return v;
};

const MARKETS: Market[] = ["BTC", "ETH"];

describe("the two gTrade deployments are one contract priced twice", () => {
  test("identical leverage bounds, on both products and both markets", () => {
    for (const [g, n] of [
      ["gains-std", "nova-std"],
      ["gains-degen", "nova-degen"],
    ] as const) {
      expect(byId(n).minLeverage).toBe(byId(g).minLeverage);
      for (const m of MARKETS) {
        expect(maxLeverageOn(byId(n), m)).toBe(maxLeverageOn(byId(g), m));
      }
    }
  });

  test("identical maintenance curve on the standard pair", () => {
    // Same thresholds means the same requirement at every leverage, so any
    // difference in room has to come from the fee and nowhere else.
    for (const lev of [1.1, 10, 25, 50, 60, 100, 200]) {
      for (const m of MARKETS) {
        expect(byId("nova-std").maintenance(lev, 200, m)).toBeCloseTo(
          byId("gains-std").maintenance(lev, 200, m),
          12,
        );
      }
      // And it is the published Gains curve, not a re-derivation of it.
      expect(byId("nova-std").maintenance(lev, 200, "BTC")).toBeCloseTo(
        (100 - gainsStandardThresholdPct(lev)) / 100 / lev,
        12,
      );
    }
  });

  test("the standard pair is where they differ, and Nova is the dearer", () => {
    for (const m of MARKETS) {
      const g = feeLegFraction(byId("gains-std"), m);
      const n = feeLegFraction(byId("nova-std"), m);
      // Gains 3.5 bps taker + half of a 1.0 bps spread = 4.0 bps.
      expect(g).toBeCloseTo(4.0e-4, 12);
      // Nova 5.0 bps taker + no spread = 5.0 bps.
      expect(n).toBeCloseTo(5.0e-4, 12);
      expect(n).toBeGreaterThan(g);
    }
  });

  test("Nova's spread is zero and was not copied from Gains", () => {
    // The specific near-miss: Gains quotes an on-chain pair spread, Nova
    // quotes none. If this ever equals Gains' value, check word 7 of pairs()
    // on Nova's diamond before believing it.
    for (const m of MARKETS) {
      expect(byId("nova-std").spreadBps[m]).toBe(0);
      expect(byId("gains-std").spreadBps[m]).toBe(1.0);
    }
  });

  test("the degen pairs are identical, which is what that row claims", () => {
    const g = byId("gains-degen");
    const n = byId("nova-degen");
    expect(n.takerBps).toBe(g.takerBps);
    for (const m of MARKETS) {
      expect(n.spreadBps[m]).toBe(g.spreadBps[m]);
      expect(feeLegFraction(n, m)).toBeCloseTo(feeLegFraction(g, m), 12);
      expect(n.maintenance(500, 500, m)).toBeCloseTo(g.maintenance(500, 500, m), 12);
    }
    // The row says so in words, so the words have to stay true.
    expect(n.sub).toContain("same terms as Gains");
  });

  test("Nova leaves strictly less room at every shared leverage", () => {
    // Same threshold, bigger fee, and the fee sits inside the trigger. This is
    // the ordering bench 295's copy now states, so it must hold here too.
    for (const lev of [10, 25, 50, 100, 200]) {
      const room = (id: string) =>
        1 / lev - byId(id).maintenance(lev, 200, "BTC") - 2 * feeLegFraction(byId(id), "BTC");
      expect(room("nova-std")).toBeLessThan(room("gains-std"));
    }
  });
});

describe("the model's provenance discipline", () => {
  test("every gTrade row is marked as read from chain", () => {
    for (const id of ["gains-std", "gains-degen", "nova-std", "nova-degen"]) {
      expect(byId(id).src).toBe("chain");
    }
  });

  test("Nova carries its own read date, since it is not MEASURED_AT", () => {
    // The footer prints MEASURED_AT for everything without an override, so a
    // row read on another day has to say so or the page misdates it.
    for (const id of ["nova-std", "nova-degen"]) {
      expect(byId(id).measuredAt).toBe("2026-10-22");
      expect(byId(id).measuredAt).not.toBe(MEASURED_AT);
    }
  });

  test("both Nova rows point at the logo and link Nova actually has", () => {
    // logoKey doubles as the provider-registry key the official link comes
    // from, so a wrong key shows one brand's mark beside another's site. The
    // perp cohort slug is "nova"; the product registry key is "nova-markets".
    for (const id of ["nova-std", "nova-degen"]) {
      expect(byId(id).logoKey).toBe("nova-markets");
    }
  });

  test("no two rows share an id", () => {
    const ids = VENUES.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
