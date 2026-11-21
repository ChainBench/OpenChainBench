import type { FeesView } from "@/lib/spec-schema";
import type { Benchmark } from "@/types/benchmark";

export type ShownVariant = {
  benchmark: Benchmark;
  shownFees: FeesView | null;
  pending: boolean;
  unpublished: boolean;
  placeholderNote: string;
};

export function shownVariant(view: {
  active: Benchmark | undefined;
  included: Benchmark | undefined;
  aggregate: Benchmark;
  fees: FeesView | null;
  unpublished: boolean;
  isAllSelection: boolean;
}): ShownVariant {
  if (view.active) {
    return {
      benchmark: view.active,
      shownFees: view.fees,
      pending: false,
      unpublished: false,
      placeholderNote: "",
    };
  }
  const { included } = view;
  return {
    benchmark: included ?? view.aggregate,
    shownFees: null,
    pending: !view.isAllSelection && !view.unpublished,
    unpublished: view.unpublished,
    placeholderNote: included
      ? "the same view with fees included"
      : aggregateNote(view.aggregate, view.fees),
  };
}

function aggregateNote(aggregate: Benchmark, fees: FeesView | null): string {
  const pinned = aggregate.aggregateFilters?.chain;
  if (!fees) return "the all-chains aggregate";
  return pinned
    ? `${pinned} with fees included`
    : "all assets with fees included";
}
