/**
 * Spec loader.
 *
 * Reads every YAML file in `benchmarks/`, validates it against the schema,
 * queries Prometheus for live numbers, and returns a `Benchmark[]` ready
 * for rendering. There are no fallback mocks. if Prometheus has nothing,
 * the benchmark renders in a "draft" state (page shows the editorial
 * metadata, but the results section is replaced by a "Awaiting first run"
 * notice).
 */

import { cache } from "react";
import { specValueKind } from "@/lib/value-window";
import { unstable_cache } from "next/cache";
import type { Benchmark } from "@/types/benchmark";
import type { Spec } from "@/lib/spec-schema";
// Imported from the isolated alias module (NOT @/lib/chains) to avoid
// a circular import: chains.ts → @/data/benchmarks → @/lib/spec. The
// cycle fails at module-eval time with "Cannot access 'X' before
// initialization" because both ends touch each other during ESM load.
import { canonicalChainSlug } from "@/lib/chain-aliases";
import { renderBenchmarkText } from "@/lib/bench-template";
import {
  chartFromSpec,
  draftPlaceholderForSpec,
  filterSig,
  loadSpecsUncached,
  type BenchmarkFilters,
} from "@/lib/materialize/load";
import { readMaterialized } from "@/lib/materialize/store";
import { loadAggregateFromBlob } from "@/lib/aggregate-blob";
import { loadBenchFromBlob, loadVariantFromBlob } from "@/lib/bench-blob";

export type { Spec } from "@/lib/spec-schema";
export type { BenchmarkFilters } from "@/lib/materialize/load";
export { bestForChain, injectLabels } from "@/lib/materialize/load";

// ─── Materialized read path (blob-only, no live Prom fallback) ────────
// The worker is the sole Prom consumer; Vercel renders read the
// worker-published snapshots and never query Prom at render time. A
// stale snapshot is preferred over a render-time Prom fan-out — when
// the worker stalls, the chart shows aged data with a freshness badge
// instead of cascading a Vercel function into Prom's query queue, which
// is what crashed Prom under load. The READ_FROM_STORE flag is
// preserved as a kill switch (unset to disable blob reads entirely;
// every render then returns undefined → draft placeholder).
const READ_FROM_STORE = process.env.READ_FROM_STORE === "1";

async function benchFromStore(
  slug: string,
  sig: string,
): Promise<Benchmark | null> {
  if (!READ_FROM_STORE) return null;
  const snap = await readMaterialized(slug, sig);
  if (!snap) return null;
  return snap.bench;
}

/**
 * Overlay the live spec's editorial fields onto a bench loaded from the
 * materialise store. Without this, an editorial-only change in the YAML
 * (new per_chain_explainer entries, FAQ tweak, seo_intro rewrite) does
 * not surface until the materialise worker re-syncs the snapshot, which
 * makes new chain routes 404 against perChainExplainer values that exist
 * in the YAML but not in the stored bench. Numeric / Prom-derived
 * fields (results, sampleSize, lastRunAt, extras, bestPerChain) are
 * preserved from the store so the snapshot's measurement payload is
 * untouched.
 */
export function overlayEditorial(stored: Benchmark, spec: Spec): Benchmark {
  // Reconcile stale provider entries in the stored snapshot against the
  // current spec. The materialize worker may have written a snapshot
  // BEFORE a chain rename rolled through the YAMLs (e.g. ton → gram).
  // For each stored result whose slug is a known legacy alias, look up
  // the spec provider for the canonical slug and rewrite the result's
  // `slug` + `name` so downstream surfaces (leaderboard table, chain
  // hub matching, search dialog) read the new identity without having
  // to wait on the worker's next sweep.
  const providerByCanonSlug = new Map(
    (spec.providers ?? []).map((p) => [canonicalChainSlug(p.slug), p]),
  );
  // Two-pass: rewrite legacy slugs to their canonical, then dedupe so a
  // chain rename in flight (e.g. ton → gram) does not surface two rows
  // for the same canonical until the 24h Prom window aged out the legacy
  // series. When duplicates land, prefer the row whose original slug
  // already matched the canonical (current harness emit) over the row
  // rewritten via alias (historical samples). Stable insertion order
  // preserves the leaderboard sort.
  const seenSlugs = new Set<string>();
  const reconciledResults: typeof stored.results = [];
  for (const r of stored.results) {
    const canon = canonicalChainSlug(r.slug);
    const isCanonical = canon === r.slug;
    if (seenSlugs.has(canon)) {
      if (!isCanonical) continue;
      const existingIdx = reconciledResults.findIndex((x) => x.slug === canon);
      if (existingIdx >= 0) reconciledResults[existingIdx] = r;
      continue;
    }
    seenSlugs.add(canon);
    if (isCanonical) {
      reconciledResults.push(r);
    } else {
      const specProvider = providerByCanonSlug.get(canon);
      reconciledResults.push(
        specProvider ? { ...r, slug: canon, name: specProvider.name } : r,
      );
    }
  }

  // Prune providers that are no longer declared in the spec. Stale
  // snapshots keep results for providers removed from the YAML (retired
  // endpoints, editorial exclusions) until the worker next sweeps. Without
  // this filter those phantom rows persist in rankings indefinitely.
  const specSlugs = new Set(providerByCanonSlug.keys());
  const prunedResults = reconciledResults
    .filter((r) => specSlugs.has(r.slug))
    // Editorial per-provider fields ride on the live YAML, like the page
    // copy above, so a new `endpoint` shows without a worker sweep.
    .map((r) => {
      const sp = providerByCanonSlug.get(r.slug);
      return sp?.endpoint ? { ...r, endpoint: sp.endpoint } : r;
    });

  const overlaid: Benchmark = {
    ...stored,
    results: prunedResults,
    // `title` drives the H1, the breadcrumb, TechArticle and /api/stat;
    // `seoTitle` drives <title>. Both come from the live YAML so a
    // retitle never leaves the H1 on the blob's older string (audit
    // 2026-09-19 round 3, blocker 1: 6 staging pages with <title> new
    // and H1 old, 10 production pages the other way round).
    title: spec.title ?? stored.title,
    seoTitle: spec.seo_title ?? stored.seoTitle,
    seoDescription: spec.seo_description ?? stored.seoDescription,
    seoIntro: spec.seo_intro ?? stored.seoIntro,
    headlineSlice: spec.headline_slice ?? stored.headlineSlice,
    faq: spec.faq ?? stored.faq,
    excludedProviders: spec.excluded_providers ?? stored.excludedProviders,
    window: spec.prometheus?.window ?? stored.window,
    expectedFreshnessSec: spec.prometheus?.expected_freshness_seconds ?? stored.expectedFreshnessSec,
    perChainExplainer: spec.per_chain_explainer ?? stored.perChainExplainer,
    abstract: spec.abstract ?? stored.abstract,
    methodology: spec.methodology ?? stored.methodology,
    findings: spec.findings ?? stored.findings,
    disclaimer: spec.disclaimer ?? stored.disclaimer,
    subtitle: spec.subtitle ?? stored.subtitle,
    // Dimensions are YAML editorial config (chain / region / kind
    // value sets the bench page surfaces as filters). Overlay them
    // too so newly added dimension values (e.g. region opts added to
    // an existing bench) surface immediately on the compare matrix
    // and the bench page filters without waiting on the materialise
    // worker to rewrite the snapshot. No `?? stored` fallback: the
    // live YAML is the source of truth, so a spec that declares NO
    // dimensions must not inherit tabs from a snapshot written by a
    // worker running a divergent branch (keyed-rpc-robinhood: main is
    // Singapore-only while dev/worker carries the region dims).
    dimensions: spec.dimensions,
    dimensionLabels: spec.dimension_labels,
    zeroIsAValue: spec.zero_is_a_value,
    chart: chartFromSpec(spec) ?? stored.chart,
    // Same source-of-truth rule as dimensions: the live YAML decides
    // the aggregate pin, never the snapshot.
    aggregateFilters: spec.aggregate_filters,
    // provider_notes is a YAML editorial declaration: drives the
    // per-provider chip rendered next to the name in the ranking row.
    // Overlay so newly added notes surface immediately without waiting
    // on the materialize worker to rewrite the snapshot.
    providerNotes: spec.provider_notes ?? stored.providerNotes,
    // expected_n is a YAML editorial declaration too: drives the
    // sample-health badge logic on the page + the citable APIs. A
    // freshly added/edited value must take effect immediately, before
    // the worker re-publishes the snapshot, otherwise a bench keeps
    // ranking 3-sample providers as healthy through the materialise
    // lag.
    // Does this bench actually compute a distribution? A provider block
    // that repeats one expression for p50, p90 and p99 has a single
    // measurement, so the UI must not badge the value "p50". Coverage and
    // count benches are all written that way; latency benches are not.
    // Overlaid from the live YAML for the same reason as the fields above.
    hasDistribution: specHasDistribution(spec) ?? stored.hasDistribution,
    // ...and when that single expression is a point read rather than an
    // aggregate, the value has no window either. Without this the page
    // labelled a last_over_time read "p50, 24h" in 42 places.
    valueKind: specValueKind(spec) ?? stored.valueKind,
    expectedN: spec.expected_n ?? stored.expectedN,
  };
  // Resolve `{{p50:slug}}`, `{{name:slug}}`, `{{best_name}}` etc. in the
  // overlaid editorial text. Without this, a YAML edit that ships AHEAD
  // of the next materialise sweep renders literal `{{p50:geckoterminal}}`
  // tokens on the page because the stored snapshot was rendered against
  // an older spec text (or never rendered at all on the fast path that
  // hits overlayEditorial directly). The materialise sweep also passes
  // its output through renderBenchmarkText; calling it here on the
  // fallback path keeps the two paths consistent.
  return renderBenchmarkText(confineToPinnedRegion(overlaid, spec));
}

// Region keys the harness emits vs the values specs declare: the Singapore
// probe was historically labelled ap-southeast.
const REGION_KEY_ALIASES: Record<string, string> = { "ap-southeast": "sgp" };
const canonRegionKey = (r: string) => REGION_KEY_ALIASES[r] ?? r;

/**
 * Single-origin surface guard. When THIS build declares no region
 * dimension but pins one region via `aggregate_filters`, the stored
 * snapshot can still carry every region the worker computed: the worker
 * runs from its own checkout, which may declare more regions than this
 * build does. Everything left on the object reaches client components and
 * therefore the RSC payload, readable in view-source even though nothing
 * renders it (2026-09-08: keyed-rpc-robinhood shipped its us-east series
 * and ranks inside `variants` while the page only ever showed Singapore).
 * Keep the pinned region's cells, drop the rest. Benches that declare
 * region tabs, or pin nothing, are returned untouched.
 */
export function confineToPinnedRegion(b: Benchmark, spec: Spec): Benchmark {
  const declared = spec.dimensions?.region ?? [];
  const pinned = (spec.aggregate_filters as { region?: string } | undefined)?.region;
  if (declared.length > 0 || typeof pinned !== "string") return b;
  const keep = (r: string) => canonRegionKey(r) === canonRegionKey(pinned);
  const byRegion = <T,>(m?: Record<string, Record<string, T>>) =>
    m
      ? Object.fromEntries(
          Object.entries(m).map(([slug, per]) => [
            slug,
            Object.fromEntries(Object.entries(per).filter(([r]) => keep(r))),
          ]),
        )
      : undefined;
  return {
    ...b,
    extras: {
      ...b.extras,
      regions: Object.fromEntries(
        Object.entries(b.extras.regions ?? {}).map(([slug, pts]) => [
          slug,
          (pts ?? []).filter((pt) => keep(pt.region)),
        ]),
      ),
      seriesByRegion24h: byRegion(b.extras.seriesByRegion24h),
      seriesByRegion7d: byRegion(b.extras.seriesByRegion7d),
      seriesByRegion30d: byRegion(b.extras.seriesByRegion30d),
    },
    cellRanks: b.cellRanks
      ? Object.fromEntries(
          Object.entries(b.cellRanks).filter(([key]) => {
            const r = key.split("|").pop() ?? "";
            return r === "" || r === "all" || keep(r);
          }),
        )
      : undefined,
  };
}

// Strip lazy-loadable series fields from the cached Benchmark to bring
// it under Next.js's 2 MB unstable_cache item limit. Heavy benches
// (hl-frontends with 104 providers, wallet-labels-coverage, etc.) were
// blowing past that ceiling once series7d + series30d + per-panel
// 7d/30d arrays were included, silently failing the cache write and
// forcing every read to re-query Prom — root cause of the Railway
// egress blowout (2026-06-29, ~150 GB/day).
//
// Kept in the cached object:
//   - extras.series24h (hub cards, mini-charts, ledger sparklines, OG)
//   - extras.seriesByRegion24h
//   - metricPanels[].seriesByProvider (24h, ledger panel rescaling)
//
// Stripped (lazy-fetched via /api/series/[slug]?range=7d|30d on tab
// click):
//   - extras.series7d, extras.series30d
//   - extras.seriesByRegion7d, extras.seriesByRegion30d
//   - metricPanels[].seriesByProvider7d, seriesByProvider30d
//
// /api/series serves these on demand, CDN-cached (60 s s-maxage + 300 s
// SWR) so the cache miss only hits Prom once per (bench, range) per
// minute regardless of concurrent visitor count.
export function slimBenchmarkForCache(b: Benchmark): Benchmark {
  const slimPanels = b.metricPanels?.map((panel) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { seriesByProvider7d, seriesByProvider30d, ...rest } = panel;
    return rest;
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { series7d, series30d, seriesByRegion7d, seriesByRegion30d, ...slimExtras } = b.extras;
  return {
    ...b,
    extras: slimExtras,
    ...(slimPanels ? { metricPanels: slimPanels } : {}),
  };
}

// Per-bench unfiltered cache. ONE unstable_cache entry per slug so a
// transient Prom hiccup on bench A doesn't poison the cache for benches
// B, C, ...Z. Inside: if a spec marked `status: live` collapses to a
// runtime draft (all providers' p50/p90/p99 came back null), we throw.
// unstable_cache treats the throw as transient: it keeps the previous
// cached value (last successful render) and serves that to readers.
// When there is no previous value (cold start during a Prom blackout),
// the throw propagates to the aggregator below which falls back to a
// draft placeholder so the page still renders.
const loadBenchmarkUnfilteredCached = unstable_cache(
  async (slug: string): Promise<Benchmark | undefined> => {
    const specs = await loadSpecs();
    const spec = specs.find((s) => s.slug === slug);
    if (!spec) return undefined;
    // Fast path: per-bench blob written by the materialize worker
    // after every tier A sweep. One CDN fetch (~20 ms edge, ~1 s cold)
    // replaces the 2-3 SRH GETs this used to run. See bench-blob.ts
    // and worker/publish-aggregate.ts.
    const fromBlob = await loadBenchFromBlob(slug);
    if (fromBlob) return slimBenchmarkForCache(overlayEditorial(fromBlob, spec));
    // Fallback: Redis-via-SRH. Kept until Phase 3 fully retires SRH.
    const stored = await benchFromStore(slug, "");
    if (stored) return slimBenchmarkForCache(overlayEditorial(stored, spec));
    if (spec.status === "live") {
      // A live spec with no readable blob is a transient store failure
      // (proxy timeout, worker mid-write), not a real state. Returning
      // undefined would cache the miss for the whole revalidate window:
      // home row + /api/stat then serve "Awaiting samples" while the
      // bench page reads fine (bnb-rpc incident, 2026-07-13). Throwing
      // makes unstable_cache keep the last good entry; cold-cache
      // callers already catch and fall back to the draft placeholder.
      throw new Error(`store blob missing for live bench ${slug}`);
    }
    return undefined;
  },
  // Version key bumped when Benchmark shape changes so stale cache entries
  // from a previous deploy can't surface objects missing newer fields.
  // v3: added bestPerChain + worstPerChain stash; cached objects from
  // v2 deploys lack those fields, which made `{{best_name:chain:X}}`
  // placeholders fall through to the raw token on the rendered page.
  // v4: added providersPerChain so per-chain rank chips only render for
  // providers that actually returned data on that chain (Solana-only
  // providers no longer get phantom chips on Base/BNB).
  // v5: forced bust after adding bench-029 (solana-dex-quote-latency) —
  // older cache entries for the all-benchmarks list didn't include the
  // new slug, so the bench was 404 on direct hit and absent from search
  // until the cache aged out.
  // v6: added cellRanks (exact chain × region rankings from
  // rank_matrix_query). Cached objects from v5 deploys lack the field,
  // which made region-scoped badge URLs 404 after the deploy.
  // v7: added ledgerColumns (per-bench ledger column relabeling).
  // v8: outage panel unit s -> sec (true seconds); cached v7 objects keep
  // the old unit and would render "0.0 s" via the ms-input formatter.
  // v9: perp-funding unit bps -> bp (true basis points display).
  // v10: bumped after adding `dimensions` to overlayEditorial (PR #506).
  // Prior cached values were written with the stored snapshot's
  // pre-overlay dimensions, so the new region opts on agg-head-lag
  // and metadata-coverage stayed invisible until the next cold cache
  // window. Bumping the key forces every read to regenerate against
  // the post-overlay shape immediately on deploy.
  // v11: bumped from v10 alongside 60s→300s revalidate (egress reduction).
  // v12: renderBenchmarkText now also resolves seoTitle / seoDescription /
  // subtitle / methodology / disclaimer (search-bar PR). Cached v11
  // entries keep the raw `{{best_name}}` token on those fields (visible
  // in client RSC payload + leaked via /api/citable → search dialog
  // description previews). Bump so the next read regenerates through
  // the wider resolver.
  // v13: overlayEditorial now reconciles stale provider slugs in stored
  // snapshots against the current spec (e.g. legacy "ton" → canonical
  // "gram" after the June 2026 rebrand). Without bumping, a v12 entry
  // would keep serving result.slug = "ton" + result.name = "TON" until
  // the materialize worker rewrites the snapshot.
  // v14: per-provider dataConfidence + sampleHealth + bench-wide
  // expectedN + dataConfidence aggregate (sample-health system). Cached
  // v13 entries lack these fields, so the sample-health badge would
  // not render on existing benches until the cache aged out.
  // v16: bumped to flush stale HL frontends snapshot after adding 6
  // identified frontends in #772 (invo/bitget-wallet/etc.).
  // v17: strip series7d/series30d/seriesByRegion7d/seriesByRegion30d
  // and metricPanels[].seriesByProvider7d/30d from cached objects. Was
  // pushing heavy benches (hl-frontends, wallet-labels-coverage) past
  // unstable_cache's 2 MB limit, silently failing the cache write and
  // forcing every render to re-query Prom. Root cause of the 150 GB/day
  // Railway egress blowout (2026-06-29). Series for 7d/30d are now
  // lazy-fetched via /api/series/<slug>?range=7d|30d on tab click.
  // v18: RPC per-chain cluster (044-053) + rpc-capabilities lost its
  // perChainExplainer. Bench SET changed; without the bump, cached v17
  // entries keep the removed explainer and miss the 10 new benches.
  // v19: ProviderResult gained `unresponsive` (cohort providers with
  // live call counters but no latency render as unranked badge rows).
  // Cached v18 entries would silently drop dead providers instead.
  // v20: +12 long-tail RPC benches 055-066 (sonic…soneium). Bench SET
  // changed; cached v19 entries would miss the new chains.
  // v21: +bench 067 (portfolio-chain-coverage). Bench SET changed.
  // v22: +bench 068 (explorer-chain-coverage) + Explorers category.
  // v26: ship of benches monad-rpc + megaeth-rpc to prod (gate list
  // shrank; prod bench SET changed).
  // v23: prod-only bench gate (REMOVED_BENCH_SLUGS filtered at loader
  // level on VERCEL_ENV=production). Bench SET now differs per env, so
  // the env is part of the cache key to keep prod and preview entries
  // from colliding.
  // v27: series arrays became dense with explicit nulls for empty Prom
  // buckets (gap rendering fix). Cached v26 entries hold the old
  // hole-compressed arrays whose indices no longer map onto the nominal
  // step grid the chart back-computes timestamps from.
// v28: bench vague 2 ships 081-085 (ws-head-latency, oracle-freshness,
  // rpc-reliability, indexer-latency, evm-block-builders). Bench SET changed.
  // v30: 081 slug renamed ws-head-latency -> ws-head-latency-ethereum for
  // parity with the base + solana siblings + ungated on prod. Bench SET
  // changed (old slug gone, new slug live). Bump to purge cached v29 that
  // still keys the old slug.
  // v31: 084 indexer-latency dropped entirely (spec + harness deleted;
  // HyperSync + The Graph required paid credentials for sustained
  // cadence). Bench SET shrank.
  // Wormhole VAA latency ship (bench 101).
  // v44: 027 solana-tx-landing-latency spec removed from main (never got prod data,
  // duplicate of 016 solana-tx-landing). Bench SET shrank.
  // v46: network-coverage split into asset-registry-coverage + dex-network-coverage
  // (bench 005 legacy slug removed, 2 new slugs added). Bench SET changed.
  // v47: staging pipeline shuffle — evm-quote-latency + indexing-freshness
  // promoted to prod; solana-dex-quote-latency held back to staging (openocean
  // 403 + raydium unresponsive = board reads half-broken to visitors).
  // v48: add bench 102 token-quote-coverage (draft). Bench SET grew.
  // v49: token-quote-coverage flipped draft→live 2026-07-26; cached
  // v48 entries hold editorialStatus=draft, so /api/stat filters it as
  // unknown_slug and the page renders "data warming up" despite fresh
  // Jupiter/Mobula runtime numbers in citable. Bench SET unchanged; the
  // bump is purely to invalidate the stale editorialStatus.
  // v53: overlayEditorial now prunes providers absent from spec.providers.
  // Bump to flush v52 cached entries that still carry stale Flashbots row.
  // v54: add 6 new chain benches 216-221 (NEAR, Flow, Hedera, CKB, MultiversX, NEO).
  // v55: add ws-head-latency-robinhood (244) + keyed-rpc-robinhood (243). Bench SET grew.
  // v56: drop 6 keyed-rpc benches (arbitrum/base/bnb/eth/polygon/solana), US-only robinhood.
  // v57: drop rpc-keyed-latency bench.
  // v63: score_scope contested_chains on bench 008 changes its provider values.
  // v64: add bench 262 fiat-onramp-cost + On-ramps category. Bench SET grew.
  // v65: add bench 265 perp-pf-ratio (dev-only) + 5 providers on bench 234. Bench SET grew.
  // v66: Benchmark.chart (default_panel_by_chain, hide_headline_by_chain); cached
  // objects without it kept the Head lag tab on Solana after the deploy.
  // v67: add bench 267 trading-app-daily-volume. Bench SET grew.
  // v69: keyed RPC cohort back (237-242 restored, 269 HyperEVM, 270 Arc) and
  // 243 Robinhood opened to 3 regions. Bench SET grew.
  // v70: bench 268 method v3: unit bp, Sandwiched panel and ledger column
  // removed, BullX and Nova out of the cohort; cached v69 entries keep the
  // old panels and providers.
  // v72: add bench 273 chain-bridged-tvl (dev-only) + Blockchains category
  // row. Bench SET grew.
  // v73: bench 273 audit round 1: panel directions, last_over_time
  // aggregates and a freshness_timestamp_metric; v72 entries keep the old
  // panels and the 24h-mean headline.
  // v74: bench 273 audit round 2: 21 chains added to the board (20 to 41
  // rows) and freshness moved onto L2Beat's own sync clock.
  // v76: add bench 274 protocol-pf-ratio (dev-only). Bench SET grew.
  // v77: add bench 275 chain-stablecoin-flow (dev-only). Bench SET grew.
  // v81: add bench 276 perp-fee-disclosure (dev-only). Bench SET grew.
  // v85: bench 274 market cap floor of $5M; 11 provider rows leave the
  // board, so cached entries hold a cohort led by a $380k token.
  // v80: bench 274 display names taken from protocol_info instead of
  // title-cased slugs; 26 of 80 were wrong, including the leader.
  // v79: bench 274 audit: categories by fee weight, the fee floor moved
  // onto the token, incomplete rows off the board. Providers and tags
  // both changed, so cached entries hold the wrong peer medians.
  // v78: valueKind, and bench 273 copy (a hand-typed 20 against 41 rows,
  // two FAQ answers the page contradicts). Cached entries carry the old
  // wording into the Dataset and the quotable sentence.
  // v75: row_noun on 31 specs. Cached entries carry the old editorial, so
  // the quotable sentence would keep saying "providers" about chains and
  // venues until they expire.
  // v71: keyed RPC cohort folded into the chain pages (tier dimension):
  // 9 keyed-rpc-* specs gone, robinhood-rpc (243) and arc-rpc (270)
  // added, ProviderResult.tier and Benchmark.tierResults. Bench SET changed.
  // v82: add bench 277 pm-open-interest. Bench SET changed.
  // v83: add bench 278 rwa-solana-depth. Bench SET changed.
  // v84 (2026-09-25): benches 273 chain-bridged-tvl, 274 protocol-pf-ratio
  // and 275 chain-stablecoin-flow leave the dev-only list. Bench SET changed.
  // v86 (2026-09-27): bench 201 and the benches reading its gauges
  // (203, 206, 207, 232) move off the frozen third-party Dune datasets onto our
  // own SQL. Methodology, disclaimers, FAQ and every provider formula are
  // rewritten, and pump.fun and BasedBot become unresponsive rows, so cached
  // entries carry the retired dataset names into the Dataset blob and the
  // quotable sentence.
  // v87 (2026-09-27): the Dune trial ends 2026-10-02, so bench 201 moves onto
  // DeFiLlama's free dexs and fees adapters (new gauges, new provider set
  // without BasedBot, a commission and take-rate panel) and benches 203, 206,
  // 207 and 232 are gated to staging. Bench SET changed and 201's providers,
  // panels and copy all changed.
  // v88 (2026-09-30): GetBlock joins the keyed cohort on the nine chain RPC
  // benches. The provider set of those benches changed, so v87 entries hold a
  // keyed cohort of three and a GetBlock exclusion row that is no longer true.
  // v89: four benches left DEV_ONLY for production (203, 206, 207, 232) and
  //      two of them changed slug, so every cached bench set is stale.
  // v90: bench 205 retired into 201.
  // v91: bench 201 renamed solana-trading-platform-wars -> trading-platform-wars.
  // v92: Nova joins bench 030's builder cohort, which takes it from 104 rows
  //      to 105. Same reason as v16, which was bumped after six builders were
  //      added to the same bench: a v91 entry holds the 104-row provider set,
  //      so the aggregate blob published 105 results with Nova live at $5.28
  //      while /api/stat and the page kept serving 104 and the row never
  //      appeared. Checked rather than assumed: the blob's Nova row is
  //      structurally identical to a row that does render (same keys, same
  //      flags, availability live) and carries better data than it, 6 fills
  //      against 0.
  // v93: Nova joins bench 041 (ranked) and bench 116 (unranked). A cached
  // entry holds the provider set current when it was written, so a bench
  // gaining a row needs the key to move or the row never appears.
  // v94: Nova joins bench 295. Unlike v93, that bench declares dimensions,
  // so bench-filters moves with this one too.
  // v95: two independent reasons, one bump.
  //   Benchmark.raceLeader and a first_share panel on the nine WebSocket
  //   race benches; a cached entry has neither and keeps printing 0.3 ms.
  //   And bench 268 gained TWO providers whose own PRs moved nothing, Pump
  //   Bridge (#3188) and FOMO · Mobula (#3226). Both were live in the
  //   materialized blob, pump-bridge at p50 269.6 over 939 swaps and
  //   fomo-mobula at 297.2 over 2,512, and neither reached the board: the
  //   chart drew 14 rows with ALL selected while the blob held 16 ranked.
  //   Exactly the failure v93's note describes, two PRs after it was
  //   written, which is the argument for spec-provider-set.test.ts rather
  //   than for a fourth note. 268 declares chain and bucket, so
  //   bench-filters moves with it.
  // v96: the nine WebSocket races' copy reads {{best_first}} (share of first
  // pushes) instead of a leader p50 that is 0 by construction.
  // v97: BlockMachine joins the keyed cohort on the seven chains it serves,
  // warm and cold, so fourteen provider rows appear across seven specs. Those
  // specs declare region and tier, so bench-filters moves with this one.
  // v98: Robinhood Chain joins l1-finality. No dimensions there, so
  // bench-filters stays.
  // v100: 0x leaves benches 304 and 033. A cached entry holds the provider
  // set current when it was written, and the direction matters as much as
  // the fact: v92's note covers a bench GAINING a row, this is a bench
  // LOSING one, and a stale entry would keep drawing a declared provider
  // that no longer exists in the spec. Both benches declare a chain
  // dimension, so bench-filters moves with this one.
  // v101: Enso leaves bench 033, the second provider in two days off that
  // board for a dead credential (0x at v100). 033 declares a chain
  // dimension, so bench-filters moves with this one.
  // v102: bench 306 privacy-round-trip arrives with two providers. It is
  // held out of production in DEV_ONLY_BENCH_SLUGS until its harness is
  // deployed, but staging renders it and a stale entry there would show the
  // board without its rows, which is the state we are trying to avoid
  // reviewing. It declares a bucket dimension, so bench-filters moves too.
  // v103: benches 307 and 301 arrive with four providers between them. Both
  // are held out of production, but staging renders them and a stale entry
  // there would show the boards without their rows, which is the state we
  // are trying to review. 301 declares a bucket dimension, so bench-filters
  // moves too.
  // v104: bench 308 arrives with seven providers. No dimensions, so
  // bench-filters stays put this time.
  // v105: bench 306 gains THORChain, a rail its harness had been measuring
  // for hours while the spec declared two. 306 declares a bucket dimension,
  // so bench-filters moves with this one.
  // v106: bench 307 gains THORChain and, more importantly, zero_is_a_value.
  // Its rows for every rail that REFUSES a shielded address were being
  // v107: the seven keyed chain pages gain a RouteMesh row, warm and cold,
  //       the first router in the private cohort. It is declared unranked,
  //       so a cached set written before it would not merely misorder the
  //       page, it would omit the row entirely.
  // v108: and out again the next morning. The trial key ran out of credits
  //       overnight (HTTP 402), so 78% of probes were refused and the row
  //       published a 22% success rate that describes our balance, not
  //       their service. A cached set still holding the row keeps serving
  //       it, which is why a removal moves these keys too.
  // dropped as no-value, so the board published only the rail that accepts,
  // which is the opposite of what it measured.
  // v108: the methodology array renders on the bench page for the first
  //       time, and seven specs reworded their tehcscreener citation to
  //       credit the project rather than only its endpoint. overlayEditorial
  //       prefers the spec over the stored copy, but an entry cached before
  //       the edit still carries the old prose. Production proved it: the
  //       deploy went green, the bullets rendered, and the sentence was
  //       still the old one until the key moved. An editorial change needs
  //       this bump exactly as a provider change does, and the provider-set
  //       hash test does not catch it because no provider moved.
  // v109: bench 309 wallet-cost arrives with thirteen embedded wallet
  //       vendors, the first bench in the Wallets category.
  // v110: bench 010's latency methodology said percentiles were computed
  //       "via histogram_quantile / quantile_over_time" over a gauge AND a
  //       histogram. Only half of that was ever true. Every published
  //       percentile comes from quantile_over_time over the gauge, nothing
  //       in the repo selected rpc_latency_milliseconds_histogram_bucket,
  //       and the histogram is removed in the same PR. Editorial change, so
  //       it needs the bump for the v108 reason two notes above.
  // v111: bench 309's copy moves after its first audit round (the
  //       Openfort reading, validate running the scorer, six of thirteen
  //       pages); an entry cached before the edit still carries the old
  //       prose.
  // v112: bench 309 lists its unpriced vendors on every tab, and its
  //       freshness copy names the new alert.
  // v113: bench 001's Base reference gains a second source. The methodology
  //       now says the zero point is the earliest of the flashblock stream
  //       and the sequencer's pendingLogs, and warns that figures published
  //       before today are smaller by up to the CDN tail the second source
  //       removes. Editorial change on a live page, so the keys move.
  // v114: bench 309 round three. Each unpriced vendor carries its own
  //       reason per view, Privy's 10,000-user band edge is badged, and
  //       the copy states validate's sample size.
  // v115: bench 309 SEO round: title, metric, intro and description
  //       move to placeholders and a plainer wording.
  // v116: the brand is Quicknode, not QuickNode, in every spec.
  // v117: bench 310 server-wallet-cost arrives (eleven vendors), and
  //       bench 309 gains Portal and re-prices Openfort's free plan.
  // v118: bench 311 rpc-api-coverage arrives, a support matrix for the keyed
  //       RPC cohort. New slug, new metric family, nothing existing moves: an
  //       `api` dimension on an existing RPC spec would inject api=... into
  //       rpc_latency_milliseconds, which carries no such label, and empty
  //       every ledger column.
  // v119: bench 311's editorial, three times in one evening. The success
  //       column became a measurement rather than the default 100, the
  //       unranked row gained its own cause in place of the generic caption,
  //       and two sentences that described the previous rendering were
  //       realigned. Entries written between v118 and now carry the old
  //       prose, and overlayEditorial prefers the spec but cannot beat an
  //       already-cached entry (measured on prod 2026-10-28: a green deploy
  //       serving the old sentence). providers-v31 deliberately does NOT
  //       move: the provider set is untouched, only its copy.
  // v120: four benches declared ledger_reliability: false, so the Success
  //       column stops being filled from the loader's default of 100 where
  //       nothing measured a success: perp-asset-breadth, privacy-coin-books,
  //       rpc-free-tier and token-deployment-cost, none of which claims
  //       anything about requests it sent. Moves with all-benchmarks-v113 and
  //       bench-filters-v58. providers-v31 deliberately does NOT move: no
  //       provider entered or left and no provider copy changed.
  // v121: bench 311 gained two panels and swapped two ledger columns. On a
  //       single chain tab the boolean columns read alike for nearly the
  //       whole cohort, which is why the robinhood tab showed four providers
  //       tied at 88.9: a five-block window is a question everyone can
  //       answer. The widest window each one accepts is where they separate,
  //       from 500 blocks to a million, so the two filtered-shape booleans
  //       are now the windows that subsume them (0 is the refusal the
  //       boolean carried). Panels are computed by the loader and live in
  //       the cached entry, so a new panel cannot reach a page without this.
  //       Moves in lockstep with all-benchmarks-v114 and bench-filters-v59.
  //       providers-v31 deliberately does NOT move: no provider entered or
  //       left and no provider copy changed.
  // v122: Helius enters the keyed Solana cohort, warm and cold. A new
  //       provider changes the ranked set, the count placeholders and the
  //       disclosure prose, none of which overlayEditorial can repair on an
  //       entry already cached. Moves with all-benchmarks-v115,
  //       bench-filters-v60 and, unusually, providers-v32: a provider
  //       entering is the case that key exists for.
  // v123: bench 311 gains four selectable views, the first measurements on a
  //       board that was all booleans and shares: the eth_call work term, the
  //       archive read, the address-filtered log query and Solana's v2
  //       getProgramAccounts. Panels are computed by the loader and live in
  //       the cached entry, so a new one cannot reach a page without this.
  //       Moves with all-benchmarks-v116 and bench-filters-v61.
  //       providers-v32 deliberately does NOT move: no provider entered or
  //       left and no provider copy changed.
  // v124: the eth_call work view withholds a non-positive difference. The
  //       first published pass read minus 1.6 ms for one provider, which on
  //       a lower-is-better view ranks the noisiest first, so the panel
  //       query now drops it and the cell reads as a dash. A panel's values
  //       live in the cached entry, so the old reading would otherwise sit
  //       there for the full TTL. Moves with all-benchmarks-v117 and
  //       bench-filters-v62.
  // v125: wallet pricing audit 2026-10-30: Dynamic re-priced on its card,
  //       Circle's signing-only plan, the price-reading pill, rewritten prose.
  //       Moves with all-benchmarks-v118 and bench-filters-v63.
  // v126: the audit's root cause. Every selector on bench 311 aggregated
  //       rpc_api_supported and rpc_api_probe_total with no `api` filter, so
  //       each probe added today silently joined the headline, the success
  //       rate, the sample size, the rank gate and the freshness column. The
  //       two eth_call legs made each chain contribute 9 cells where the copy
  //       describes 7, putting every ranked headline 0.9 to 5.2 points high;
  //       the range ladder writes a probe counter without a capability gauge,
  //       so the success denominator grew by two APIs and every ranked row
  //       read 81.8 percent where the spec's own definition gives 100. All 67
  //       selectors now carry the capability allowlist, the freshness column
  //       reads the OLDEST stamp rather than the newest, the Solana view is
  //       gone (its chain pin survived injection and showed Solana values on
  //       every EVM tab), and the FAQ no longer answers that the window
  //       measurement does not exist above the columns that publish it.
  //       Moves with all-benchmarks-v119 and bench-filters-v64.
  // v127: the two wallet pricing titles say {{year}} instead of a typed
  //       2026. Moves with all-benchmarks-v120 and bench-filters-v65.
  // v128: the wallet pricing findings and FAQ read their winners and
  //       bills from the curve ({{cell:...}}). Moves with
  //       all-benchmarks-v121 and bench-filters-v66.
  // v129: bench 312 paymaster-cost arrives (nine vendors; Pimlico,
  //       Etherspot and Candide new to the site). Moves with
  //       all-benchmarks-v122 and bench-filters-v67.
  // v129: the per-chain leader stash stops crowning a gated row and stops
  //       breaking ties by spec order. bestPerChain lives in the cached
  //       entry and feeds the product-page chip, so a stale one keeps
  //       publishing "#1 of 5 on Robinhood Chain" for a row the board shows
  //       unranked. Moves with all-benchmarks-v122, bench-filters-v67 and
  //       providers-v34, which is the key the chip itself reads through.
  // v130: the per-chain leader stash stops crowning a gated row and
  //       stops breaking ties by spec order. bestPerChain feeds the
  //       product-page chip, so a stale entry keeps publishing
  //       "#1 of 5 on Robinhood Chain" for a row the board shows
  //       unranked. Moves with all-benchmarks-v123, bench-filters-v68
  //       and providers-v35.
  // v131: the two window columns select bound=~"refused|top", so a figure
  //       the ladder reached before one of OUR OWN calls failed is no longer
  //       printed as the provider's limit; the audit found Quicknode
  //       publishing 10,000 on seven chains after an HTTP error at the
  //       100,000 rung. The eth_call view's copy moves with it: both legs
  //       are primed now, so the handshake is paid outside the measurement
  //       instead of inside a difference of a few milliseconds. Moves with
  //       all-benchmarks-v124 and bench-filters-v69.
  // v132: cost bench audit round (309, 310, 312): headline_slice, copy
  //       read from the curve, the bot FAQ. Moves with all-benchmarks-v125
  //       and bench-filters-v70.
  // v133: the eth_call work panel declares carry: false. Measured on the
  //       published blob: chainstack read minus 1.84 ms with staleSince in
  //       its valuesMeta, so the `> 0` guard was working and the panel carry
  //       was resurrecting the value it had refused, for the length of this
  //       bench's 24 h ceiling, first on a lower-is-better view. The cached
  //       entry holds panel values, so the old one stays without this.
  ["bench-unfiltered-v133", process.env.VERCEL_ENV === "production" ? "prod" : "all"],
  { revalidate: 300, tags: ["benchmarks"] },
);

// Sentinel thrown by the aggregator when EVERY bench collapses to
// draft. Catchable by name at call sites that want to fall back to
// placeholders (page rendering) vs. propagate as 503 (APIs and feeds).
//
// Why an explicit error type: returning the draft set from the cached
// path poisons unstable_cache (Upstash KV) with an all-draft snapshot
// that then serves as "truth" to every downstream consumer for the
// rest of the revalidate window. /api/citable was the visible symptom.
// Throwing instead makes unstable_cache keep the previous good value
// and skip writing the bad one.
export class AllBenchmarksDraftError extends Error {
  readonly slugCount: number;
  constructor(slugCount: number) {
    super(
      `loadAllBenchmarks: every bench (${slugCount}) collapsed to draft. ` +
        "Refusing to cache the all-draft set. Likely Prom blackout or " +
        "cold start with no KV snapshot.",
    );
    this.name = "AllBenchmarksDraftError";
    this.slugCount = slugCount;
  }
}

/**
 * Pure aggregation step. Exported for tests. Given a spec list and a
 * per-bench loader (real or mocked), fans out in parallel, substitutes
 * a draft placeholder for any per-bench throw, and throws
 * AllBenchmarksDraftError when literally every bench resolves to draft.
 *
 * Kept separate from the unstable_cache wrapper below so the test
 * suite can exercise the error path without standing up Prometheus or
 * the Next cache backend.
 */
/** Concurrency cap for the parallel per-bench Redis fan-out below.
 *
 *  The naive `Promise.allSettled(specs.map(loadOne))` fires ~68 read
 *  chains at once (each does GET pointer → GET blob → optional GET lkg =
 *  ~150-200 Redis ops), which reliably saturated SRH's request pool and
 *  starved the alphabetically-later specs (`perp-open-interest` → `zksync-rpc`)
 *  into 8s timeouts — they then rendered as draft placeholders on the
 *  homepage even though their blobs were sitting in Redis the whole time.
 *
 *  Cap at 12 in-flight chains so the total concurrent Redis ops stay
 *  well under the pool ceiling. The aggregate is behind unstable_cache
 *  (revalidate 300 s) so the slightly-longer worst-case wall time on
 *  cache miss is invisible to end users. */
const AGGREGATE_LOAD_CONCURRENCY = 12;

async function limitedAllSettled<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export async function aggregateBenchmarks(
  specs: Spec[],
  loadOne: (slug: string) => Promise<Benchmark | undefined>,
): Promise<Benchmark[]> {
  const settled = await limitedAllSettled(
    specs,
    AGGREGATE_LOAD_CONCURRENCY,
    (s) => loadOne(s.slug),
  );
  const benchmarks: Benchmark[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const r = settled[i];
    if (r.status === "fulfilled" && r.value) {
      benchmarks.push(r.value);
    } else {
      // Per-bench throw fired with no previous cache to fall back to.
      // Surface a placeholder so the page still renders rather than
      // dropping the bench from the list (which would break the sitemap,
      // the products pages, and the "More benchmarks" rail).
      // [DRAFT-TRACE] this path produces a visible "draft" render. Log
      // so we can correlate with KV / Prom state.
      const reason =
        r.status === "rejected"
          ? r.reason instanceof Error
            ? r.reason.message
            : String(r.reason)
          : "no_value";
      console.warn(
        `[DRAFT-TRACE] placeholder_used slug=${spec.slug} reason=${reason}`,
      );
      benchmarks.push(draftPlaceholderForSpec(spec));
    }
  }
  const live = benchmarks.filter((b) => b.status === "live");
  const liveSpecs = specs.filter((s) => s.status === "live");
  // Quorum guard. The previous "all-draft only" threshold let through
  // mixed sets where 24 of 26 specs declared live had collapsed to
  // placeholder while 2 trickled in live — that mostly-bad set then
  // cached for 60s and made /api/citable report status=insufficient
  // for benches whose per-slug /api/stat path returned live data. When
  // most editorially live specs fail to produce a live bench in the
  // current run, treat the cycle as a load failure and throw, so
  // unstable_cache keeps the previous good value.
  //
  // Floor of 4 avoids tripping the guard on tiny dev fixtures with
  // a single deliberately-failing bench in the test suite.
  const QUORUM_MIN_LIVE_SPECS = 4;
  const quorumLost =
    liveSpecs.length >= QUORUM_MIN_LIVE_SPECS &&
    live.length * 2 < liveSpecs.length;
  if (benchmarks.length > 0 && (live.length === 0 || quorumLost)) {
    console.warn(
      `[DRAFT-TRACE] aggregate_quorum_lost live=${live.length}/${liveSpecs.length} (total=${benchmarks.length}) throwing to preserve previous cache value`,
    );
    throw new AllBenchmarksDraftError(benchmarks.length);
  }
  return benchmarks.sort((a, b) => a.number.localeCompare(b.number));
}

// Aggregator: fan out to N per-bench caches in parallel via
// Promise.allSettled so a single bench's transient throw doesn't bring
// down the whole list. See aggregateBenchmarks for the actual logic.
// This wrapper layers unstable_cache on top so the result is shared
// across requests with 300s revalidate (the option is on the call below;
// several API routes size their own edge windows against this number, so
// the two have to be read together).
const loadAllBenchmarksCached = unstable_cache(
  async (): Promise<Benchmark[]> => {
    const specs = await loadSpecs();
    return aggregateBenchmarks(specs, loadBenchmarkUnfilteredCached);
  },
  // v6: aggregate cache. Bumped together with bench-unfiltered-v4 so
  // the per-bench providersPerChain field actually propagates into the
  // benchmark slice the products page reads. Without bumping this, the
  // outer cache can keep serving v5-era benchmarks (no providersPerChain)
  // even after the inner cache is fresh.
  // v8: bumped with bench-unfiltered-v6 (cellRanks) for the same reason.
  // v9: bumped with bench-unfiltered-v7 (ledgerColumns).
  // v10: bumped with bench-unfiltered-v8 (sec unit).
  // v11: bumped with bench-unfiltered-v9 (bp unit).
  // v12: bumped with bench-unfiltered-v10 (dimensions overlay).
  // v13: bumped to flush any poisoned all-draft snapshot written by the
  // pre-fix code path during a Prom blackout. The fix throws on
  // all-draft so unstable_cache no longer caches the bad set, but any
  // already-stored v12 snapshot in Upstash KV would still serve for up
  // to 60s after deploy. Bumping the key sidesteps that window.
  // v14: bumped to flush a mostly-draft snapshot (24/26 placeholders)
  // that survived the v13 fix because the previous throw only fired
  // on a literally all-draft set. The aggregateBenchmarks quorum guard
  // now throws on any cycle where fewer than half of editorially live
  // specs produce a live bench.
  // v15: bumped with bench-unfiltered-v11 (egress reduction).
  // v16: bumped with bench-unfiltered-v12 (wider renderBenchmarkText
  // coverage, search-bar PR). Without bumping this, products / citable /
  // sitemap surfaces would keep serving v15 benches with raw
  // `{{best_name}}` in seoDescription for up to 300s after deploy.
  // v17: bumped with bench-unfiltered-v13 (slug reconciliation in
  // overlayEditorial). Without this, /api/citable and the products
  // page would keep serving v16 benches with stale "ton" results.
  // v18: bumped with bench-unfiltered-v14 (sample-health system).
  // Without this, /api/citable + products + sitemap surfaces would
  // keep serving v17 benches without the new dataConfidence /
  // sampleHealth / expectedN fields.
  // v20: bumped with bench-unfiltered-v16 to flush the HL frontends
  // snapshot that didn't include the 6 newly identified frontends.
  // v21: bumped with bench-unfiltered-v17 (slim cached objects — strip
  // 7d/30d series from extras + panels so the cache stays under 2 MB).
  // v22: bumped with bench-unfiltered-v18 (RPC per-chain cluster
  // 044-053; parent rpc-capabilities lost perChainExplainer). Without
  // this, sitemap/citable/products kept emitting the removed
  // rpc-capabilities/<chain> variant URLs and missing the 10 new
  // <chain>-rpc benches after deploy.
  // v23: bumped with bench-unfiltered-v19 (unresponsive provider rows).
  // v24: bumped with bench-unfiltered-v20 (+12 long-tail RPC benches
  // 055-066; sitemap/citable/products must pick up the new slugs).
  // v25: bumped with bench-unfiltered-v21 (+bench 067 portfolio-chain-coverage).
  // v26: bumped with bench-unfiltered-v22 (+bench 068 explorer-chain-coverage).
  // v27: bumped with bench-unfiltered-v25 (prod-only bench gate); env in key.
  // v28: bumped with bench-unfiltered-v25->v25 ship of bench 074 (mev-protect-rpc
  // ungated; the lockstep bump was missed in #1105 and prod kept serving the
  // gated catalog to /products for 30+ min after the deploy).
  // v29: bumped with bench-unfiltered-v26 (monad-rpc + megaeth-rpc ship).
  // v30: bumped with bench-unfiltered-v27 (dense series with nulls).
// v31: bumped with bench-unfiltered-v28 (bench vague 2, 081-085).
  // v32: bumped with bench-unfiltered-v30 (081 slug rename ws-head-latency
  // -> ws-head-latency-ethereum + ungate on prod).
  // v34: bumped with bench-unfiltered-v31 (084 indexer-latency dropped).
  // Wormhole VAA latency ship (bench 101).
  // v47: 027 solana-tx-landing-latency removed from main (see bench-unfiltered-v46).
  // v49: network-coverage split into asset-registry-coverage + dex-network-coverage
  // (bench SET changed, see bench-unfiltered-v46).
  // v50: staging pipeline shuffle (see bench-unfiltered-v47).
  // v51: add bench 102 token-quote-coverage (draft, see bench-unfiltered-v48).
  // v52: token-quote-coverage flipped draft→live (see bench-unfiltered-v49).
  // v53: lockstep with bench-unfiltered-v53 (Flashbots prune).
  // v57: lockstep with bench-unfiltered-v54 (add 6 new chain benches 216-221).
  // v59: lockstep with bench-unfiltered-v64 (add bench 262 fiat-onramp-cost).
  // v60: lockstep with bench-unfiltered-v65 (add bench 265 perp-pf-ratio).
  // v61: lockstep with bench-unfiltered-v66 (Benchmark.chart).
  // v62: lockstep with bench-unfiltered-v67 (add bench 267 trading-app-daily-volume).
  // v64: lockstep with bench-unfiltered-v69 (keyed RPC cohort).
  // v65: lockstep with bench-unfiltered-v71 (keyed cohort folded into chain pages).
  // v66: lockstep with bench-unfiltered-v72 (add bench 273 chain-bridged-tvl).
  // v67: lockstep with bench-unfiltered-v73 (bench 273 audit round 1).
  // v68: lockstep with bench-unfiltered-v74 (bench 273 audit round 2).
  // v69: lockstep with bench-unfiltered-v75 (row_noun).
  // v70: lockstep with bench-unfiltered-v76 (add bench 274).
  // v71: lockstep with bench-unfiltered-v77 (add bench 275).
  // v72: lockstep with bench-unfiltered-v78 (valueKind + 273 copy).
  // v73: lockstep with bench-unfiltered-v79 (bench 274 audit).
  // v74: lockstep with bench-unfiltered-v80 (bench 274 names).
  // v75: lockstep with bench-unfiltered-v81 (add bench 276).
  // v76: lockstep with bench-unfiltered-v82 (add bench 277).
  // v77: bumped with bench-unfiltered-v84 (273, 274, 275 join the set).
  // v78: lockstep with bench-unfiltered-v85 (bench 274 market cap floor).
  // v79: lockstep with bench-unfiltered-v86 (bench 201 source swap).
  // v80: lockstep with bench-unfiltered-v87 (bench 201 to DeFiLlama, four
  // Dune benches gated).
  // v81: lockstep with bench-unfiltered-v88 (GetBlock joins the keyed cohort
  // on the nine chain RPC benches).
  // v82: lockstep with bench-unfiltered-v89 (four benches to production, two
  //      renamed).
  // v83: lockstep with bench-unfiltered-v90.
  // v84: lockstep with bench-unfiltered-v91.
  // v85: lockstep with bench-unfiltered-v92 (Nova joins bench 030).
  // v86: lockstep with bench-unfiltered-v93 (Nova joins benches 041 and 116).
  // v87: lockstep with bench-unfiltered-v94 (Nova joins bench 295).
  // v88: lockstep with bench-unfiltered-v95 (raceLeader on the WebSocket
  // races, and Pump Bridge and FOMO · Mobula joining bench 268).
  // v89: lockstep with bench-unfiltered-v96 (WebSocket race copy).
  // v90: lockstep with bench-unfiltered-v97 (BlockMachine joins the keyed
  // cohort on seven chains).
  // v92: lockstep with bench-unfiltered-v99 (bench 306 deleted: its two
  // provider sets leave the hash, and a cached aggregate written before
  // this would still list a bench that no longer exists).
  // v91: lockstep with bench-unfiltered-v98 (Robinhood Chain on l1-finality).
  // v93: lockstep with bench-unfiltered-v100 (0x leaves benches 304 and 033).
  // v94: lockstep with bench-unfiltered-v101 (Enso leaves bench 033).
  // v95: lockstep with bench-unfiltered-v102 (bench 306 arrives).
  // v96: lockstep with bench-unfiltered-v103 (benches 307 and 301 arrive).
  // v97: lockstep with bench-unfiltered-v104 (bench 308 arrives).
  // v98: lockstep with bench-unfiltered-v105 (bench 306 gains a third rail).
  // v99: lockstep with bench-unfiltered-v106 (bench 307 gains a row and
  // stops dropping its zeros).
  // v100: lockstep with bench-unfiltered-v107 (RouteMesh joins the keyed
  //        cohort on seven chain pages, warm and cold).
  // v101: lockstep with bench-unfiltered-v108 (RouteMesh back out, trial
  //        credits exhausted).
  // v101: lockstep with bench-unfiltered-v108 (methodology renders).
  // v102: lockstep with bench-unfiltered-v109 (bench 309 arrives).
  // v103: lockstep with bench-unfiltered-v110 (bench 010's latency
  //        methodology no longer credits a histogram that drove nothing).
  // v104: lockstep with bench-unfiltered-v111 (bench 309 copy round).
  // v105: lockstep with bench-unfiltered-v112 (bench 309 round two).
  // v106: lockstep with bench-unfiltered-v113 (bench 001's Base reference
  //        gains the sequencer's pendingLogs as a second source).
  // v107: lockstep with bench-unfiltered-v114 (bench 309 round three).
  // v108: lockstep with bench-unfiltered-v115 (bench 309 SEO round).
  // v109: lockstep with bench-unfiltered-v116 (Quicknode spelling).
  // v110: lockstep with bench-unfiltered-v117 (bench 310 arrives).
  // v111: lockstep with bench-unfiltered-v118 (bench 311 arrives).
  // v112: lockstep with bench-unfiltered-v119 (bench 311's editorial:
  //        a measured success column, the unranked row's own cause, and
  //        two sentences realigned to the rendering they describe).
  // v113: lockstep with bench-unfiltered-v120, and with bench-filters-v58, for the
  //       four specs that declared ledger_reliability: false. The aggregate
  //       carries each bench's rendered reliability column, so an entry
  //       written before this holds the fabricated 100 percent.
  // v114: lockstep with bench-unfiltered-v121, and with bench-filters-v59, for
  //       bench 311's two window panels. The aggregate carries each bench's
  //       rendered columns, so an entry written before this holds the two
  //       booleans the windows replaced.
  // v115: lockstep with bench-unfiltered-v122, Helius entering the keyed
  //       Solana cohort.
  // v116: lockstep with bench-unfiltered-v123, bench 311's four views.
  // v117: lockstep with bench-unfiltered-v124.
  // v118: lockstep with bench-unfiltered-v125 (wallet pricing audit).
  // v119: lockstep with bench-unfiltered-v126.
  // v120: lockstep with bench-unfiltered-v127 (wallet titles).
  // v121: lockstep with bench-unfiltered-v128 (cell placeholders).
  // v122: lockstep with bench-unfiltered-v129 (bench 312).
  // v122: lockstep with bench-unfiltered-v129 (per-chain leader).
  // v123: lockstep with bench-unfiltered-v130 (per-chain leader).
  // v124: lockstep with bench-unfiltered-v131 (ladder bound, primed legs).
  // v125: lockstep with bench-unfiltered-v132 (cost bench audit round).
  // v126: lockstep with bench-unfiltered-v133 (panel carry).
  ["all-benchmarks-v126", process.env.VERCEL_ENV === "production" ? "prod" : "all"],
  { revalidate: 300, tags: ["benchmarks"] },
);
export const loadAllBenchmarks = cache(loadAllBenchmarksCached);

/**
 * Safe wrapper for build-time and page-render callers that must produce
 * SOMETHING even during a full Prom blackout. Catches the all-draft
 * sentinel and substitutes a draft-placeholder list built directly from
 * the specs. Does not cache the fallback (so the next call hits the
 * cached path again and recovers as soon as Prom is back).
 *
 * Use this for: pages rendered at build time (`next build` enumerates
 * generateStaticParams over benches; a throw there crashes the build),
 * and for hub pages that should degrade gracefully to placeholders.
 *
 * Do NOT use this for: /api/citable, /api/llm-context, /llms.txt,
 * /rss.xml, /api/cron/*. Those callers should let the throw surface and
 * return 503 so downstream consumers (LLM agents, RSS readers, crons)
 * don't silently treat the placeholder set as ground truth.
 */
export const loadAllBenchmarksSafe = cache(
  async (): Promise<Benchmark[]> => {
    // Fast path: CDN-cached aggregate blob written by the materialize
    // worker every ~60 s (see src/lib/aggregate-blob.ts and
    // worker/publish-aggregate.ts). One HTTP fetch replaces the ~150
    // concurrent SRH GETs the per-bench aggregator used to fan out on
    // every homepage revalidate — that fan-out is what saturated SRH's
    // pool and starved alphabetically-later specs into draft
    // placeholders. Any failure (network, schema, quorum) falls through
    // to the Redis-via-SRH path below, so the switch is safe: the worst
    // case is what we had before this landed.
    const fromBlob = await loadAggregateFromBlob().catch(() => null);
    if (fromBlob && fromBlob.length >= 40) {
      return fromBlob;
    }

    try {
      return await loadAllBenchmarksCached();
    } catch (err) {
      if (err instanceof AllBenchmarksDraftError) {
        const specs = await loadSpecs();
        return specs
          .map((s) => draftPlaceholderForSpec(s))
          .sort((a, b) => a.number.localeCompare(b.number));
      }
      throw err;
    }
  },
);


/**
 * Cross-request server cache for filtered loads. Each (slug, filters) combo
 * is computed at most once per `revalidate` window across ALL concurrent
 * users - so the page-level pre-fetch (which loads every chain × region
 * variant in parallel) hits a warm cache after the first miss instead of
 * triggering N × Prom queries on every render.
 *
 * Cache key includes a stable filter signature so adding new dimensions
 * later won't collide with prior cache entries.
 */
const loadBenchmarkFiltered = unstable_cache(
  async (slug: string, sig: string): Promise<Benchmark | undefined> => {
    const specs = await loadSpecs();
    const spec = specs.find((s) => s.slug === slug);
    if (!spec) return undefined;
    // Fast path: per-variant blob written by the worker's tier B
    // sweep. Missing blob → this filter combo hasn't been covered yet
    // (or the tier B has never run since worker start) — fall through
    // to Redis-via-SRH.
    const fromBlob = await loadVariantFromBlob(slug, sig);
    if (fromBlob) return slimBenchmarkForCache(overlayEditorial(fromBlob, spec));
    const stored = await benchFromStore(slug, sig);
    if (stored) return slimBenchmarkForCache(overlayEditorial(stored, spec));
    return undefined;
  },
  // v4: bumped with bench-unfiltered-v7 (ledgerColumns).
  // v5: bumped with bench-unfiltered-v8 (sec unit).
  // v6: bumped with bench-unfiltered-v9 (bp unit).
  // v7: bumped with bench-unfiltered-v10 (dimensions overlay).
  // v8: bumped with bench-unfiltered-v11 (egress reduction).
  // v9: bumped with bench-unfiltered-v17 (slim cached objects).
  // v10: bumped with bench-unfiltered-v18 (RPC per-chain cluster).
  // v11: bumped with bench-unfiltered-v19 (unresponsive provider rows;
  // region variants flag providers dead on that slice).
  // v12: bumped with bench-unfiltered-v20 (+12 long-tail RPC benches
  // 055-066).
  // v13: bumped with bench-unfiltered-v21 (+bench 067 portfolio-chain-coverage).
  // v14: bumped with bench-unfiltered-v22 (+bench 068 explorer-chain-coverage).
  // v15: bumped with bench-unfiltered-v25 (prod-only bench gate); env in key.
  // v16: bumped with the bench 074 ship (lockstep rule, see all-benchmarks-v28).
  // v17: bumped with the monad-rpc + megaeth-rpc ship (lockstep rule).
  // v18: bumped with bench-unfiltered-v27 (dense series with nulls).
  // v19: bumped with bench-unfiltered-v28 (bench vague 2, 081-085).
  // v21: bumped with bench-unfiltered-v46 (network-coverage split).
  // v23: lockstep with bench-unfiltered-v56 (keyed-rpc cleanup).
  // v24: lockstep with bench-unfiltered-v57 (drop rpc-keyed-latency).
  // v30: lockstep with bench-unfiltered-v66 (Benchmark.chart on variants).
  // v31: lockstep with bench-unfiltered-v71 (tier variants).
  // v32: lockstep with bench-unfiltered-v88. The GetBlock row lives only in
  // the tier=keyed variants, so without this bump the keyed tabs keep serving
  // a three-provider cohort.
  // v33: lockstep with bench-unfiltered-v89. The four new production benches
  //      carry a chain dimension the cached filter sets do not know about.
  // v34: lockstep with bench-unfiltered-v90.
  // v35: lockstep with bench-unfiltered-v91.
  // v36: lockstep with bench-unfiltered-v94. Bench 295 declares kind and
  // bucket dimensions, so its filtered variants are cached here as well,
  // and a new provider is invisible on every tab until this moves. v93
  // deliberately did not move it: none of the three benches Nova joined
  // then had dimensions.
  // v37: lockstep with bench-unfiltered-v95. The WebSocket races declare a
  // region dimension, so their per-region variants carry the new panel, and
  // bench 268 declares chain and bucket, so its two new providers are
  // invisible on every tab until this moves. Same reason v36 existed.
  // v38: lockstep with bench-unfiltered-v96 (WebSocket race copy).
  // v40: lockstep with bench-unfiltered-v99. Bench 306 declared dimensions,
  // so its filtered variants are cached under this key too and a stale entry
  // would keep serving them on every tab but the default.
  // v39: lockstep with bench-unfiltered-v97. The seven keyed RPC specs
  // declare region and tier, and BlockMachine's rows are on the Private
  // access tab, which is a filtered variant: without this they are invisible
  // on exactly the tab they belong to.
  // v41: lockstep with bench-unfiltered-v100. Benches 304 and 033 both
  // declare a chain dimension, so every per-chain variant caches its own
  // copy of the provider set and a stale entry keeps 0x on each tab.
  // v42: lockstep with bench-unfiltered-v101. 033 declares a chain
  // dimension, so each per-chain variant caches its own provider set and a
  // stale entry keeps Enso on all four tabs it published on.
  // v43: lockstep with bench-unfiltered-v102. Bench 306's three size rungs
  // are filtered variants, so without this the selector renders only its
  // default tab.
  // v44: lockstep with bench-unfiltered-v103. Bench 301 declares a bucket
  // dimension, so its two size tabs are filtered variants.
  // v45: lockstep with bench-unfiltered-v105. Without it the new row is
  // invisible on every size tab but the default.
  // v46: lockstep with bench-unfiltered-v107. The chain pages declare tier
  //      and region, so without this bump RouteMesh is missing from every
  //      tab including the Private one it lives on.
  // v47: lockstep with bench-unfiltered-v108. Same reason inverted: without
  //      it the paused row survives on every filtered tab.
  // v48: lockstep with bench-unfiltered-v109. Bench 309 declares kind and
  //      bucket dimensions, so its profile and size tabs are filtered
  //      variants that need their own entries.
  // v49: lockstep with bench-unfiltered-v110. Bench 010 declares a chain
  //      dimension, so its reworded latency methodology is cached once per
  //      chain tab; without this the correction lands on the default tab
  //      only and the other tabs keep crediting the histogram.
  // v50: lockstep with bench-unfiltered-v111. Bench 309's profile and
  //      size tabs cache the copy alongside the rows.
  // v51: lockstep with bench-unfiltered-v112. Bench 309's filtered
  //      tabs gain rows (unpriced vendors with their label), and a cached
  //      variant would keep the old, shorter set.
  // v52: lockstep with bench-unfiltered-v113. Bench 001 declares chain and
  //      region dimensions, so its reworded Base methodology is cached once
  //      per tab and a bump of the other two alone would correct only one.
  // v53: lockstep with bench-unfiltered-v114. Bench 309's filtered
  //      tabs now carry per-vendor reasons; a cached variant keeps the old.
  // v54: lockstep with bench-unfiltered-v115. Bench 309's tabs cache
  //      the title and metric with the rows.
  // v55: lockstep with bench-unfiltered-v117. Bench 310 declares kind
  //      and bucket, and bench 309's tabs gain a row.
  // v56: lockstep with bench-unfiltered-v118. Bench 311 declares a chain
  //      dimension and its whole board is panel-backed columns, so every tab
  //      is a filtered variant.
  // v57: lockstep with bench-unfiltered-v119. Same editorial, and it has
  //      to move with it: every one of this bench's eight tabs is a
  //      filtered variant, so copy fixed only on the default view would
  //      stay wrong on all eight.
  // v58: lockstep with bench-unfiltered-v120, and with all-benchmarks-v113. Filtered
  //      views are cached per filter set and each one carries the same
  //      column, so leaving this behind would serve the fabricated figure on
  //      every tab of the four benches while the unfiltered view was correct.
  // v59: lockstep with bench-unfiltered-v121, and with all-benchmarks-v114.
  //      The chain tabs are exactly where this matters: the window columns
  //      exist because the per-chain view was the one reading as a four-way
  //      tie, so a stale filtered entry would keep serving the tie on every
  //      tab while the unfiltered view carried the fix.
  // v60: lockstep with bench-unfiltered-v122. The Access selector is a
  //      filtered view, so the keyed and cold cohorts are exactly the
  //      entries that would otherwise keep a four-provider Solana board.
  // v61: lockstep with bench-unfiltered-v123. A view is selectable on every
  //      chain tab, so a stale filtered entry would offer the tabs without
  //      the panels behind them.
  // v62: lockstep with bench-unfiltered-v124.
  // v63: lockstep with bench-unfiltered-v125 (wallet pricing audit).
  // v64: lockstep with bench-unfiltered-v126. Every chain tab carried the
  //      same inflated headline and the same 9/11 success rate.
  // v65: lockstep with bench-unfiltered-v127.
  // v66: lockstep with bench-unfiltered-v128.
  // v67: lockstep with bench-unfiltered-v129.
  // v68: lockstep with bench-unfiltered-v130 (per-chain leader).
  // v69: lockstep with bench-unfiltered-v131 (ladder bound).
  // v70: lockstep with bench-unfiltered-v132 (cost bench audit round).
  // v71: lockstep with bench-unfiltered-v133 (panel carry).
  ["bench-filters-v71", process.env.VERCEL_ENV === "production" ? "prod" : "all"],
  { revalidate: 300, tags: ["benchmarks"] }
);


/**
 * Load a single bench with optional dimension filters applied to all queries.
 * Each filter injects `<label>="<value>"` into every PromQL label selector.
 */
export const loadBenchmark = cache(async function loadBenchmark(
  slug: string,
  options: BenchmarkFilters = {}
): Promise<Benchmark | undefined> {
  const sig = filterSig(options);
  if (!sig) {
    // Per-slug read first: rebuilding the all-benchmarks aggregate on
    // cache expiry pulls EVERY bench's snapshot (~28 store blobs, 5-7s
    // measured), and the callers here (variant API, OG images, per-chain
    // pages) need only this one bench. The aggregate list stays as
    // fallback for the draft-placeholder path.
    try {
      const one = await loadBenchmarkUnfilteredCached(slug);
      if (one) return one;
    } catch {
      // live spec collapsed with no cached value — placeholder below
    }
    // Safe fallback. The strict aggregator throws AllBenchmarksDraftError
    // when the quorum guard trips, which would crash `next build` and any
    // page that calls getBenchmark during a Prom blackout. The safe
    // wrapper catches that throw and substitutes draft placeholders so
    // the page still renders.
    const all = await loadAllBenchmarksSafe();
    return all.find((b) => b.slug === slug);
  }
  // The filtered cache throws when a live spec collapses to draft so the
  // last good cached value survives transient Prom hiccups. The throw
  // only resurfaces here on COLD CACHE (build time or a fresh function
  // instance during a blackout) — in that case unstable_cache has no
  // prior value to substitute and the rejection propagates up. Catch it
  // and fall back to the unfiltered "All" view so the page still renders
  // (sitemap, build, products pages all rely on this never throwing).
  try {
    const result = await loadBenchmarkFiltered(slug, sig);
    if (!result) return result;
    const specs = await loadSpecs();
    const spec = specs.find((s) => s.slug === slug);
    return spec ? overlayEditorial(result, spec) : result;
  } catch {
    // Safe fallback. The strict aggregator throws AllBenchmarksDraftError
    // when the quorum guard trips, which would crash `next build` and any
    // page that calls getBenchmark during a Prom blackout. The safe
    // wrapper catches that throw and substitutes draft placeholders so
    // the page still renders.
    const all = await loadAllBenchmarksSafe();
    return all.find((b) => b.slug === slug);
  }
});

export const getSpecs = (): Promise<Spec[]> => loadSpecs();

const loadSpecs = cache(loadSpecsUncached);

/**
 * True when at least one provider declares p50, p90 and p99 as expressions
 * that are not all identical. Undefined when the spec declares no provider
 * queries at all, so the caller can fall back to whatever the snapshot held
 * rather than asserting "no distribution" about a spec it could not read.
 */
function specHasDistribution(spec: {
  providers?: { queries?: { p50?: string; p90?: string; p99?: string } }[];
}): boolean | undefined {
  const providers = spec.providers ?? [];
  let sawQueries = false;
  for (const p of providers) {
    const q = p.queries;
    if (!q?.p50) continue;
    sawQueries = true;
    const distinct = new Set(
      [q.p50, q.p90, q.p99].filter((x): x is string => !!x).map((x) => x.trim()),
    );
    if (distinct.size > 1) return true;
  }
  return sawQueries ? false : undefined;
}
