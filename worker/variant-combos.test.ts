import { describe, expect, test } from "bun:test";
import { variantCombos } from "./variant-combos";
import { filterSig } from "@/lib/materialize/load";
import type { Spec } from "@/lib/spec-schema";

// The app never builds a filtered view on demand: loadBenchmarkFiltered
// reads the worker's blob, then Redis, then returns undefined and the
// variant route falls back to the aggregate. So a dimension the worker
// does not enumerate is not a missing tab, it is a tab that shows the
// unfiltered numbers under a filtered label.

const spec = (dimensions: Spec["dimensions"]): Spec =>
  ({ slug: "t", dimensions, providers: [] }) as unknown as Spec;

describe("variantCombos covers every declared dimension", () => {
  test("a bucket dimension produces its own variants", () => {
    const combos = variantCombos(
      spec({
        bucket: [
          { value: "all", label: "All sizes" },
          { value: "under25", label: "Under $25" },
          { value: "over250", label: "Over $250" },
        ],
      }),
    );
    const sigs = combos.map(filterSig);
    expect(sigs).toContain("bucket=under25");
    expect(sigs).toContain("bucket=over250");
    expect(combos.some((c) => c.bucket === "all")).toBe(false); // the aggregate is the "all" view
  });

  test("bucket is crossed with chain, so Solana + Under $25 exists", () => {
    const combos = variantCombos(
      spec({
        chain: [
          { value: "all", label: "All chains" },
          { value: "solana", label: "Solana" },
        ],
        bucket: [
          { value: "all", label: "All sizes" },
          { value: "under25", label: "Under $25" },
        ],
      }),
    );
    const sigs = combos.map(filterSig);
    expect(sigs).toContain("bucket=under25&chain=solana");
    expect(sigs).toContain("chain=solana");
    expect(sigs).toContain("bucket=under25");
    expect(sigs.length).toBe(3); // 2x2 minus the aggregate
  });

  test("a spec with no bucket dimension is unchanged", () => {
    const combos = variantCombos(
      spec({ chain: [{ value: "all", label: "All" }, { value: "base", label: "Base" }] }),
    );
    expect(combos).toEqual([{ chain: "base" }]);
  });
});

describe("variantCombos on a bench with a fees-removed view", () => {
  const chains: Spec["dimensions"] = {
    chain: [
      { value: "ETH", label: "ETH" },
      { value: "BTC", label: "BTC" },
    ],
  };

  test("every chain tab also exists with fees removed", () => {
    const combos = variantCombos({
      ...spec(chains),
      fees_removed: {
        metric: "Spread + impact",
        panel_main_label: "Spread + impact at $1k",
        formula: "Half-spread plus impact.",
        metric_rename: { perp_fees_all_in_bps: "perp_fees_spread_bps" },
      },
    } as unknown as Spec);
    const sigs = combos.map(filterSig).sort();
    expect(sigs).toEqual([
      "chain=BTC",
      "chain=BTC&fees=removed",
      "chain=ETH",
      "chain=ETH&fees=removed",
      "fees=removed",
    ]);
  });
});
