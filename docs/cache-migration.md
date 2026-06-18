# Cache migration

## Why this doc exists

`src/lib/spec.ts` carries this comment block on a single cache wrapper:

```
// v3: added bestPerChain + worstPerChain stash
// v4: added providersPerChain
// v5: forced bust after adding bench-029
// v6: added cellRanks
// v7: added ledgerColumns
// v8: outage panel unit s -> sec
// v9: perp-funding unit bps -> bp
// v10: bumped after adding `dimensions` to overlayEditorial
```

Ten manual cache-key bumps, each tied to a regression on prod when the
bump was forgotten across a deploy. Same class of bug repeats in
`src/lib/providers.ts` (`providers-v1`), `src/lib/related-providers.ts`
(`alternatives-reverse-map-v1`), `src/app/api/freshness/route.ts`
(`freshness-v2`), and elsewhere.

Goal: make this class of bug structurally impossible.

## The plan

There are two end states to consider.

### End state A — Next 16 Cache Components (`'use cache'` + `cacheTag`)

Requires `cacheComponents: true` in `next.config.ts`. Per
`node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-cache.md`
and `node_modules/next/dist/docs/01-app/02-guides/migrating-to-cache-components.md`:

- All pages become dynamic by default.
- Every uncached data access must be wrapped in `'use cache'` or fenced
  by `<Suspense>`. Build fails otherwise.
- `runtime = 'edge'` is unsupported.
- `dynamic`, `revalidate`, `fetchCache` route segment configs are
  replaced by `'use cache'` + `cacheLife(...)`.
- Cache entries live on the in-memory LRU by default; cross-instance
  persistence needs `'use cache: remote'` (Vercel charges separately).

This is a flag-day migration that touches every page and every cron
route. Not in scope for the pilot.

### End state B (pilot, shipped this PR) — centralised tag registry + auto build-id keying

Keeps `unstable_cache` (not deprecated, ships in Next 16) and fixes the
root cause of the regressions today:

- `src/lib/cache-tags.ts` exports `BUILD_ID`, `CACHE_TAGS`, `cacheKey()`.
- `BUILD_ID` resolves from `VERCEL_GIT_COMMIT_SHA`, so folding it into
  `keyParts` auto-busts every cache entry on every deploy. Forgetting to
  bump the manual `vN` is no longer a failure mode because the deploy
  itself is the bump.
- `CACHE_TAGS` typed registry replaces inline tag literals. Lint/TS
  catches typos and rename-without-update bugs.
- Future migration to `'use cache'` reuses `CACHE_TAGS` verbatim — the
  tag literals will be the same strings passed to `cacheTag(...)`.

## Before / after

```ts
// Before — manual vN, inline tag literal, easy to forget on shape change
const buildAlternativesReverseMapCached = unstable_cache(
  async () => { /* ... */ },
  ["alternatives-reverse-map-v1"],
  { revalidate: 60, tags: ["benchmarks"] },
);

// After — deploy SHA in keyParts, tag from registry
const buildAlternativesReverseMapCached = unstable_cache(
  async () => { /* ... */ },
  cacheKey("alternatives-reverse-map"),
  { revalidate: 60, tags: [CACHE_TAGS.benchmarks] },
);
```

## Migration checklist for the remaining `unstable_cache` call sites

Order is by risk (low to high). For each site:

1. Import `CACHE_TAGS, cacheKey` from `@/lib/cache-tags`.
2. Replace the `["…-vN"]` keyParts with `cacheKey("…")` (drop the `-vN`
   suffix; deploy SHA does the bump).
3. Replace inline tag literals (`"benchmarks"`, `"freshness"`, …) with
   `CACHE_TAGS.<name>`. Add a new entry to the registry if needed.
4. Delete the now-obsolete `// vN: bumped because …` comment block. The
   git history is the bump log from this point forward.

### P0 — low-risk, pure YAML / derived data

- [x] `src/lib/related-providers.ts` — `alternatives-reverse-map-v1`
      *(shipped in the pilot PR)*
- [ ] `src/lib/providers.ts` — `providers-v1`
- [ ] `src/lib/compare-pairing.ts` — current `buildCompareGraphCached`
      keyParts (single revalidate site)

### P1 — touches Prom but bounded blast radius

- [ ] `src/app/api/freshness/route.ts` — `freshness-v2`. New tag
      `CACHE_TAGS.freshness` already declared.
- [ ] `src/app/api/chain/[slug]/live-prices/route.ts` —
      `chain-kpis-live`. New tag `CACHE_TAGS.chainKpisLive` already
      declared.
- [ ] `src/lib/hl-builder-stats.ts` — `fetchHlBuilderStatsCached`.

### P2 — critical render path, migrate last

These are the wrappers that triggered the 10+ historical regressions.
Migrate one at a time with extra review (`spec.ts` powers every bench
page and the materialise worker reads from it):

- [ ] `src/lib/spec.ts` — `loadBenchmarkUnfilteredCached`
      (`bench-unfiltered-v10`)
- [ ] `src/lib/spec.ts` — `loadAllBenchmarksCached` (`all-benchmarks-v12`)
- [ ] `src/lib/spec.ts` — `loadBenchmarkFiltered` (current keyParts)

## Wiring up `revalidateTag`

Today the codebase declares tags on every wrapper but never calls
`revalidateTag`. With `BUILD_ID` in the keyParts the deploy-time bust
covers shape drift; on-demand invalidation between deploys (e.g. when
the materialise worker writes a fresh snapshot) still needs an explicit
call.

Suggested call sites once a writer exists:

- After `writeSnapshot` succeeds in `src/lib/snapshot.ts`, call
  `revalidateTag(CACHE_TAGS.benchmarks)` for the bench whose snapshot
  was rewritten. This collapses the 60 s stale window between writer and
  reader.
- In `src/app/api/cron/health-check/route.ts` after a successful
  pre-warm, optional belt-and-braces flush.

Both are follow-up tickets, not part of the pilot PR.

## Migrating to Cache Components later

When we're ready for end-state A, the migration is:

1. Add `cacheComponents: true` to `next.config.ts`.
2. Walk every page; each uncached data access either gets `'use cache'`
   at the top or moves into a `<Suspense>` boundary.
3. Replace each `unstable_cache(fn, key, { revalidate, tags })` with:
   ```ts
   export async function fn(...args) {
     "use cache";
     cacheLife("minutes"); // or hours/days based on the current revalidate
     cacheTag(CACHE_TAGS.benchmarks);
     // body
   }
   ```
4. Delete `cacheKey()` and `BUILD_ID` — `'use cache'` derives its key
   from the function signature + build hash internally, so the deploy
   bust is automatic.
5. `CACHE_TAGS` survives unchanged.

The pilot's centralised `CACHE_TAGS` registry is the same surface
`cacheTag()` will read from, so all P0/P1/P2 migration work above is a
prerequisite — not throwaway — for end state A.
