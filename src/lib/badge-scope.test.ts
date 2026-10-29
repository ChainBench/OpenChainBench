import { describe, expect, it } from "bun:test";

import {
  type BadgeScopeInput,
  type RankPoint,
  resolveBadgeScope,
} from "@/lib/badge-scope";

/**
 * The measured case, because it is the reason the rule exists.
 *
 * On production, 2026-10-29, /api/badge/perp-fees/hyperliquid answered
 * "#6/11, 0.048%" under four different labels: no scope, ETH, BTC and SOL.
 * perp-fees declares a chain dimension and no `rank_matrix_query`, so the
 * chain path fell through to an approximation whose value is the unfiltered
 * median for everyone except the chain's own leader. The figure was the same
 * because it was always the same figure; only the label moved.
 *
 * So these tests are about the pairing, not about ranking: a requested-scope
 * label may only ever sit on a figure measured in that scope.
 */

const CELL: RankPoint = { rank: 2, total: 9, value: 41 };

function input(over: Partial<BadgeScopeInput> = {}): BadgeScopeInput {
  return {
    chain: null,
    region: null,
    cell: null,
    chainLabel: (c) => ({ eth: "Ethereum", btc: "Bitcoin" })[c] ?? c,
    regionLabel: (r) => ({ sgp: "Singapore" })[r] ?? r,
    hasChainDimension: true,
    hasRegionDimension: false,
    cohortLabel: null,
    defaultViewLabel: null,
    ...over,
  };
}

describe("resolveBadgeScope", () => {
  it("serves the cell and names the requested chain when the cell is ranked", () => {
    const got = resolveBadgeScope(input({ chain: "eth", cell: CELL }));
    expect(got).toEqual({ serve: "cell", rank: CELL, scopeLabel: "Ethereum" });
  });

  it("names chain and region together for a combined cell", () => {
    const got = resolveBadgeScope(
      input({ chain: "eth", region: "sgp", hasRegionDimension: true, cell: CELL }),
    );
    expect(got.serve).toBe("cell");
    expect(got.serve === "cell" && got.scopeLabel).toBe("Ethereum · Singapore");
  });

  it("falls back to the aggregate for a chain the bench cannot rank", () => {
    const got = resolveBadgeScope(input({ chain: "eth" }));
    expect(got).toEqual({ serve: "aggregate", scopeLabel: "all chains" });
  });

  it("never prints a chain label over a figure it did not measure", () => {
    // The whole fault in one assertion: perp-fees asked about ETH, BTC and
    // SOL. None of the three may reach the label.
    for (const chain of ["eth", "btc", "sol"]) {
      const got = resolveBadgeScope(input({ chain }));
      expect(got.serve).toBe("aggregate");
      const label = got.serve === "withhold" ? "" : got.scopeLabel;
      expect(label).toBe("all chains");
      expect(label.toLowerCase()).not.toContain(chain);
    }
  });

  it("withholds rather than substitute the aggregate for a region", () => {
    expect(
      resolveBadgeScope(input({ region: "sgp", hasRegionDimension: true })),
    ).toEqual({ serve: "withhold" });
  });

  it("withholds a combined scope whose cell is missing", () => {
    expect(
      resolveBadgeScope(
        input({ chain: "eth", region: "sgp", hasRegionDimension: true }),
      ),
    ).toEqual({ serve: "withhold" });
  });

  it("hints both dimensions on the aggregate when the bench declares both", () => {
    const got = resolveBadgeScope(input({ hasRegionDimension: true }));
    expect(got.serve === "aggregate" && got.scopeLabel).toBe(
      "all chains · all regions",
    );
  });

  it("emits no aggregate hint for a bench with no dimensions", () => {
    const got = resolveBadgeScope(
      input({ hasChainDimension: false, hasRegionDimension: false }),
    );
    expect(got).toEqual({ serve: "aggregate", scopeLabel: "" });
  });

  it("carries the cohort label on both the cell and the aggregate", () => {
    const cell = resolveBadgeScope(
      input({ chain: "eth", cell: CELL, cohortLabel: "Keyed" }),
    );
    expect(cell.serve === "cell" && cell.scopeLabel).toBe("Ethereum · Keyed");
    const agg = resolveBadgeScope(input({ cohortLabel: "Keyed" }));
    expect(agg.serve === "aggregate" && agg.scopeLabel).toBe(
      "all chains · Keyed",
    );
  });

  it("keeps the default-view slice on the aggregate only", () => {
    // A rank earned on one profile reads as overall without it, so the
    // aggregate says which slice. A cell already names its own scope.
    const agg = resolveBadgeScope(input({ defaultViewLabel: "1 ETH trade" }));
    expect(agg.serve === "aggregate" && agg.scopeLabel).toBe(
      "all chains · 1 ETH trade",
    );
    const cell = resolveBadgeScope(
      input({ chain: "eth", cell: CELL, defaultViewLabel: "1 ETH trade" }),
    );
    expect(cell.serve === "cell" && cell.scopeLabel).toBe("Ethereum");
  });

  it("passes the cell's own rank through untouched", () => {
    // The cell path is the one place a scoped figure comes from, so it must
    // not be recomputed or rounded on the way out.
    const odd: RankPoint = { rank: 11, total: 11, value: 0.0481234 };
    const got = resolveBadgeScope(input({ chain: "btc", cell: odd }));
    expect(got.serve === "cell" && got.rank).toBe(odd);
  });
});
