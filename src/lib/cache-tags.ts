/**
 * Centralised cache invalidation surface for OpenChainBench.
 *
 * Background
 * ----------
 * Every `unstable_cache` wrapper across the data layer ships two knobs:
 *
 *   1. `keyParts`  — a stable array. The convention so far has been
 *      `["something-vN"]`. Whenever a cached object SHAPE changed (new
 *      field, renamed field, unit change, …), the human author was
 *      expected to remember to bump `vN -> v(N+1)` on EVERY wrapper that
 *      cached that shape. We have 10+ historical regressions on
 *      `src/lib/spec.ts` alone (see the `// v3 … v10` comment block on
 *      `loadBenchmarkUnfilteredCached`) where the bump was forgotten and
 *      the next deploy served stale objects missing the new field.
 *
 *   2. `tags`      — a string array used by `revalidateTag()`. Today
 *      every site already declares the same tag literal (`"benchmarks"`)
 *      but typo'd inline at each call site.
 *
 * What this module does
 * ---------------------
 * - Exports `CACHE_TAGS` so the tag literal stops being inline-typed
 *   (one source of truth, lint catches typos).
 * - Exports `BUILD_ID`, a per-deploy build identifier derived from
 *   `VERCEL_GIT_COMMIT_SHA`. Cache wrappers that fold `BUILD_ID` into
 *   their `keyParts` get an automatic cache-bust on every deploy, which
 *   is exactly what the manual `vN` bumps were trying to encode. No more
 *   "forgot to bump the version" regressions.
 * - Exports `cacheKey(baseKey)` as the recommended `keyParts` helper.
 *
 * Why not migrate to `'use cache'` + `cacheTag()` (Next 16 Cache
 * Components) directly?
 * -----------------------------------------------------------------
 * Cache Components requires `cacheComponents: true` in `next.config.ts`
 * (per `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-cache.md`).
 * That flag is a flag-day migration: all pages become dynamic by
 * default, every uncached data access must be wrapped, edge runtime is
 * unsupported. That's far beyond the scope of a pilot — see
 * `docs/cache-migration.md` for the full migration path.
 *
 * This module is the bridge: it lets us keep `unstable_cache` (which is
 * NOT deprecated and still ships in Next 16) while killing the
 * manual-bump class of regressions today, and it gives us the centralised
 * tag registry that the eventual `cacheTag()` migration will reuse
 * verbatim.
 */

/**
 * Per-deploy build identifier. When folded into a cache wrapper's
 * `keyParts`, every deploy invalidates the cache automatically. The
 * cached function still runs against the fresh code, so shape drift
 * across deploys can never surface stale objects.
 *
 * Resolution order:
 *   1. `VERCEL_GIT_COMMIT_SHA`  — production / preview on Vercel.
 *   2. `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA`  — exposed mirror.
 *   3. `"local"`  — local dev, single key for the whole session.
 *
 * Same resolution as `src/lib/compare-cache.ts:computeInputsHash` so the
 * two cache layers invalidate together on every deploy.
 */
export const BUILD_ID: string =
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
  "local";

/**
 * The canonical tag registry. Every `unstable_cache` site that wants to
 * participate in on-demand invalidation reads its tag from here, NOT as
 * an inline literal. `revalidateTag` consumers read from here too.
 *
 * Adding a new tag: declare it here first, then reference it from the
 * cache wrapper(s). Tags are cheap (max 128 per cache entry, 256 chars
 * each per Next 16 docs) so it's fine to declare narrow ones.
 */
export const CACHE_TAGS = {
  /** Anything derived from the benchmark catalog — specs, results, Prom
   *  data. Today every cache wrapper across the data layer carries this
   *  tag. Invalidated by the materialise worker after a fresh snapshot
   *  write, or by an admin trigger when a YAML edit ships. */
  benchmarks: "benchmarks",
  /** Freshness probe (`/api/freshness`). Polled every ~2 s by the
   *  LiveIndicator, kept as its own tag so a benchmarks invalidation
   *  doesn't force the indicator to refresh every site-wide flush. */
  freshness: "freshness",
  /** Per-chain native price + mcap KPI gauges. Lives on its own
   *  schedule because the chain-kpis harness scrapes Mobula at a
   *  separate cadence. */
  chainKpisLive: "chain-kpis-live",
} as const;

export type CacheTag = (typeof CACHE_TAGS)[keyof typeof CACHE_TAGS];

/**
 * Build a stable `keyParts` array for `unstable_cache`.
 *
 * Usage:
 *   const myCache = unstable_cache(
 *     loader,
 *     cacheKey("my-feature"),
 *     { revalidate: 60, tags: [CACHE_TAGS.benchmarks] },
 *   );
 *
 * The returned array is `[base, BUILD_ID]`, so two cached entries with
 * the same `base` from two different deploys live at different cache
 * keys and the old one is never read. This is the "no more manual vN
 * bumps" property.
 */
export function cacheKey(base: string): string[] {
  return [base, BUILD_ID];
}
