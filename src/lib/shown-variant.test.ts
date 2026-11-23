import { describe, expect, test } from "bun:test";
import { shownVariant } from "./shown-variant";
import { perpFeesBoard } from "@/test/benchmark";

const ethAllIn = perpFeesBoard({
  metric: "ETH all-in",
  aggregateFilters: { chain: "ETH" },
});
const solAllIn = perpFeesBoard({ metric: "SOL all-in" });
const solSpread = perpFeesBoard({ metric: "SOL spread" });

describe("shownVariant with fees removed", () => {
  const removedOnSol = {
    aggregate: ethAllIn,
    fees: "removed" as const,
    isAllSelection: false,
  };

  test.each([
    {
      name: "loaded: the fees-removed board, chart on the same view",
      view: { active: solSpread, included: solAllIn, unpublished: true },
      expected: {
        benchmark: solSpread,
        shownFees: "removed",
        pending: false,
        unpublished: false,
      },
    },
    {
      name: "loading: the same chain with fees included",
      view: { active: undefined, included: solAllIn, unpublished: false },
      expected: {
        benchmark: solAllIn,
        shownFees: null,
        pending: true,
        unpublished: false,
      },
    },
    {
      name: "not published: stops loading and keeps fees included",
      view: { active: undefined, included: solAllIn, unpublished: true },
      expected: {
        benchmark: solAllIn,
        shownFees: null,
        pending: false,
        unpublished: true,
      },
    },
    {
      name: "not published, same chain not loaded: the pinned asset, named",
      view: { active: undefined, included: undefined, unpublished: true },
      expected: {
        benchmark: ethAllIn,
        shownFees: null,
        pending: false,
        placeholderNote: "ETH with fees included",
      },
    },
  ])("$name", ({ view, expected }) => {
    expect(shownVariant({ ...removedOnSol, ...view })).toMatchObject(expected);
  });

});

describe("shownVariant with fees included", () => {
  test("the all-chains view is the aggregate and never loads", () => {
    const shown = shownVariant({
      active: undefined,
      included: undefined,
      aggregate: ethAllIn,
      fees: null,
      unpublished: false,
      isAllSelection: true,
    });

    expect(shown.benchmark).toBe(ethAllIn);
    expect(shown.pending).toBe(false);
  });

  test("a chain tab still loading dims over the aggregate", () => {
    const shown = shownVariant({
      active: undefined,
      included: undefined,
      aggregate: ethAllIn,
      fees: null,
      unpublished: false,
      isAllSelection: false,
    });

    expect(shown).toMatchObject({
      benchmark: ethAllIn,
      pending: true,
      unpublished: false,
      placeholderNote: "the all-chains aggregate",
    });
  });
});
