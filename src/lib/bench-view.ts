import type { Benchmark } from "@/types/benchmark";

/**
 * The view a bench's headline ranking was computed on, in words, for any
 * bench that declares dimensions other than chain, region and tier.
 *
 * A cost bench ranks one slice by default (bench 282: the dapp mix at 10M
 * requests; bench 309: a consumer app at 10,000 users) and publishes the
 * other slices as tabs. A "#1" earned on the default slice and printed with
 * no scope reads as "#1 overall", which on those benches is exactly what
 * the findings say does not exist: Reown leads two of bench 309's nine
 * cells and its badge said "cheapest embedded wallet" (audit 2026-10-29).
 *
 * Returns "" when the bench declares none of these axes, so callers can
 * append it unconditionally. The label of each axis's "all" entry is used,
 * because that is the slice the unfiltered view selects, and the spec
 * already names it honestly ("Consumer app, 5 transactions a user").
 */
export function defaultViewLabel(b: Pick<Benchmark, "dimensions">): string {
  const parts: string[] = [];
  for (const key of ["kind", "venue", "bucket"] as const) {
    const opts = b.dimensions?.[key];
    if (!opts || opts.length < 2) continue;
    const def = opts.find((o) => o.value === "all") ?? opts[0];
    if (def?.label) parts.push(def.label);
  }
  return parts.join(" · ");
}
