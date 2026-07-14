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
  draftPlaceholderForSpec,
  filterSig,
  loadSpecsUncached,
  type BenchmarkFilters,
} from "@/lib/materialize/load";
import { readMaterialized } from "@/lib/materialize/store";

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
function overlayEditorial(stored: Benchmark, spec: Spec): Benchmark {
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

  const overlaid: Benchmark = {
    ...stored,
    results: reconciledResults,
    seoTitle: spec.seo_title ?? stored.seoTitle,
    seoDescription: spec.seo_description ?? stored.seoDescription,
    seoIntro: spec.seo_intro ?? stored.seoIntro,
    faq: spec.faq ?? stored.faq,
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
    // worker to rewrite the snapshot.
    dimensions: spec.dimensions ?? stored.dimensions,
    // expected_n is a YAML editorial declaration too: drives the
    // sample-health badge logic on the page + the citable APIs. A
    // freshly added/edited value must take effect immediately, before
    // the worker re-publishes the snapshot, otherwise a bench keeps
    // ranking 3-sample providers as healthy through the materialise
    // lag.
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
  return renderBenchmarkText(overlaid);
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
function slimBenchmarkForCache(b: Benchmark): Benchmark {
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
    // Blob-only: serve whatever the worker last published. Missing or
    // unparseable blobs fall through to the aggregator's draft
    // placeholder instead of fanning out a Prom build at render time —
    // that fan-out is what saturated Prom's query queue under Vercel
    // ISR re-render bursts.
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
  ["bench-unfiltered-v28", process.env.VERCEL_ENV === "production" ? "prod" : "all"],
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
export async function aggregateBenchmarks(
  specs: Spec[],
  loadOne: (slug: string) => Promise<Benchmark | undefined>,
): Promise<Benchmark[]> {
  const settled = await Promise.allSettled(specs.map((s) => loadOne(s.slug)));
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
// across requests with 60s revalidate.
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
  ["all-benchmarks-v31", process.env.VERCEL_ENV === "production" ? "prod" : "all"],
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
    // Blob-only: variant blobs are published by the worker's tier-B
    // sweep. A missing variant blob means the worker has not covered
    // this filter combination yet — return undefined so the caller can
    // fall back to the unfiltered "All" view rather than spinning up a
    // render-time Prom build.
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
  ["bench-filters-v19", process.env.VERCEL_ENV === "production" ? "prod" : "all"],
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



