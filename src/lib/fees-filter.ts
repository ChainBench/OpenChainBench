import type { FeesView } from "@/lib/spec-schema";
import type { Benchmark } from "@/types/benchmark";

export function feesFilter(
  raw: string | null,
  bench: Pick<Benchmark, "feesRemovable">,
): { fees?: FeesView } | null {
  const value = raw?.toLowerCase().trim();
  if (!value || value === "included") return {};
  if (value === "removed" && bench.feesRemovable) return { fees: "removed" };
  return null;
}
