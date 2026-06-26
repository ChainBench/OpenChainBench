/** Shared helpers for benchmark dimension option lists.
 *
 *  Dimension axes (chain, region, kind, variant, layer) carry a synthetic
 *  "all" option that represents the cross-axis aggregate. Most call sites
 *  that walk the per-axis values want only the concrete entries, so they
 *  filter that synthetic row out. This module centralises the filter so
 *  the comparison is consistent (case-insensitive) and the intent reads
 *  the same at every call site.
 *
 *  The "all" sentinel is also threaded through query strings, cache keys,
 *  and PromQL label injectors as a plain string. We expose a typed
 *  constant + guard + coercer here so dimension filters stop being raw
 *  `string | null | undefined` at every call site and start being a
 *  closed union the type checker can reason about. Runtime behaviour is
 *  unchanged: `isAll("all")` returns true for every value that previously
 *  matched `=== "all"`, including the case-insensitive comparison used by
 *  the loader and sitemap. */

/** Sentinel value for "no filter / all variants". The dimension layer
 *  threads this through query strings, cache keys and PromQL label
 *  injectors as a literal string; keeping it `as const` lets the union
 *  type below survive narrowing across module boundaries. */
export const ALL = "all" as const;
export type AllSentinel = typeof ALL;

/** Generic dimension filter value: either the "all" sentinel or a
 *  specific dimension slug (chain id, region code, kind, etc.). Most
 *  consumers parameterise this with `string` because the concrete set of
 *  values is bench-spec-driven (every YAML declares its own chains and
 *  kinds); the generic parameter exists for the few axes that ARE closed
 *  (e.g. `ProviderLayer = "l1" | "l2"`). */
export type DimensionValue<S extends string = string> = AllSentinel | S;

/** Type guard: returns true for the "all" sentinel, an empty string, or
 *  null/undefined input. Mirrors the `!v || v === "all"` shorthand that
 *  every dimension call site hand-rolls today. Case-insensitive so the
 *  same call covers "ALL" / "All" / "all" that the YAML loader and the
 *  page layer already treat as equivalent. */
export function isAll(v: string | null | undefined): v is AllSentinel {
  if (v == null) return true;
  return v.toLowerCase() === ALL;
}

/** Coerce a nullable string into a typed dimension value. Returns the
 *  fallback (ALL by default) when the input is null/undefined or the
 *  "all" sentinel; otherwise returns the value as-is, narrowed to the
 *  caller's slug union. */
export function asDimensionValue<S extends string>(
  v: string | null | undefined,
  fallback: AllSentinel = ALL,
): DimensionValue<S> {
  if (isAll(v)) return fallback;
  return v as S;
}

/** Drop the synthetic "all" entry from a dimension option list.
 *  Case-insensitive on the `value` field so "ALL" / "All" / "all"
 *  all get stripped, matching what the YAML loader and the page
 *  layer already assume. */
export function nonAllValues<T extends { value: string }>(options: T[]): T[] {
  return options.filter((o) => !isAll(o.value));
}
