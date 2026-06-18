/** Shared helpers for benchmark dimension option lists.
 *
 *  Dimension axes (chain, region, ...) carry a synthetic "all" option
 *  that represents the cross-axis aggregate. Most call sites that walk
 *  the per-axis values want only the concrete entries, so they filter
 *  that synthetic row out. This module centralises the filter so the
 *  comparison is consistent (case-insensitive) and the intent reads
 *  the same at every call site. */

/** Drop the synthetic "all" entry from a dimension option list.
 *  Case-insensitive on the `value` field so "ALL" / "All" / "all"
 *  all get stripped, matching what the YAML loader and the page
 *  layer already assume. */
export function nonAllValues<T extends { value: string }>(options: T[]): T[] {
  return options.filter((o) => o.value.toLowerCase() !== "all");
}
