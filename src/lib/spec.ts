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
import { canonicalChainSlug } from "@/lib/chains";
import { renderBenchmarkText } from "@/lib/bench-template";
import {
  buildEditorial,
  draftPlaceholderForSpec,
  filterSig,
  loadSpecsUncached,
  parseFilterSig,
  specToBenchmark,
  type BenchmarkFilters,
} from "@/lib/materialize/load";
import {
  readSnapshot,
  snapshotFromBenchmark,
  writeSnapshot,
} from "@/lib/snapshot";
import { readMaterialized } from "@/lib/materialize/store";

export type { Spec } from "@/lib/spec-schema";
export type { BenchmarkFilters } from "@/lib/materialize/load";
export { bestForChain, injectLabels } from "@/lib/materialize/load";

// ─── Materialized read path (phase 1, flag-gated) ────────────────────
// When READ_FROM_STORE=1, benches are served from the worker-published
// snapshots (complete, carry-forward, ~60s fresh) instead of querying
// Prom at render time. The live path below stays as fallback: store
// miss, parse failure, or a snapshot older than STORE_MAX_AGE_MS (worker
// down) all fall through to the old behavior. Rollback = unset the flag.
const READ_FROM_STORE = process.env.READ_FROM_STORE === "1";
const STORE_MAX_AGE_MS = 30 * 60_000;

async function benchFromStore(
  slug: string,
  sig: string,
): Promise<Benchmark | null> {
  if (!READ_FROM_STORE) return null;
  const snap = await readMaterialized(slug, sig);
  if (!snap) return null;
  if (Date.now() - snap.builtAt > STORE_MAX_AGE_MS) {
    console.warn(
      `[materialize] snapshot for ${slug}/${sig || "all"} is ${Math.round((Date.now() - snap.builtAt) / 60000)}min old, falling back to live`,
    );
    return null;
  }
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
  const reconciledResults = stored.results.map((r) => {
    const canon = canonicalChainSlug(r.slug);
    if (canon === r.slug) return r;
    const specProvider = providerByCanonSlug.get(canon);
    if (!specProvider) return r;
    return { ...r, slug: canon, name: specProvider.name };
  });

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
    const stored = await benchFromStore(slug, "");
    if (stored) return overlayEditorial(stored, spec);
    const promStart = Date.now();
    const bench = await specToBenchmark(spec, {}, {
      onRendered: (rendered) =>
        writeSnapshot(spec.slug, snapshotFromBenchmark(rendered)),
    });
    const promMs = Date.now() - promStart;
    if (spec.status === "live" && bench.status === "draft") {
      // Live spec, but Prom returned nothing this cycle. Try the
      // persistent snapshot before giving up. This is the cold-start
      // path: a fresh Vercel instance with no in-memory cache, called
      // during a Prom blackout. With KV configured we serve the last
      // good data; without KV we throw to preserve any previous cache
      // value (or eventually fall through to the draft placeholder in
      // the aggregator).
      // [DRAFT-TRACE] temporary observability — remove once we've pinned
      // the cause of intermittent draft renders.
      console.warn(
        `[DRAFT-TRACE] collapse slug=${slug} prom_ms=${promMs} → trying KV snapshot`,
      );
      const kvStart = Date.now();
      const snap = await readSnapshot(slug);
      const kvMs = Date.now() - kvStart;
      if (snap) {
        console.warn(
          `[DRAFT-TRACE] kv_hit slug=${slug} kv_ms=${kvMs} → serving snapshot`,
        );
        const editorial = buildEditorial(spec);
        const reconstructed = renderBenchmarkText({ ...editorial, ...snap });
        // The reconstructed bench is live data, just sourced from KV
        // instead of Prom. Mark providers as live (snapshot only
        // captures providers that did return data).
        for (const r of reconstructed.results) {
          if (!r.availability) r.availability = "live";
        }
        return reconstructed;
      }
      console.warn(
        `[DRAFT-TRACE] kv_miss slug=${slug} kv_ms=${kvMs} → throwing to keep prev cache`,
      );
      throw new Error(
        `loadBenchmark(${slug}): live spec collapsed to draft, keeping prev cache`,
      );
    }
    return bench;
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
  ["bench-unfiltered-v13"],
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
  ["all-benchmarks-v17"],
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
    const stored = await benchFromStore(slug, sig);
    if (stored) return overlayEditorial(stored, spec);
    const bench = await specToBenchmark(spec, parseFilterSig(sig));
    // Same stale-while-revalidate as loadAllBenchmarks: if Prom drops the
    // single bench we just queried to draft, throw so unstable_cache keeps
    // the previous live entry instead of overwriting with n/a.
    //
    // Bug fix: previously checked `editorialStatus !== "live"`, which is
    // sourced from the YAML and never changes at runtime — so the throw
    // never fired for editorially-live benches. Comparing runtime
    // `bench.status` to editorial `spec.status` catches the real collapse
    // case: spec says live, Prom returned nothing, runtime fell to draft.
    if (spec.status === "live" && bench.status === "draft") {
      throw new Error(
        `loadBenchmark(${slug}): live spec collapsed to draft, keeping prev cache`,
      );
    }
    return bench;
  },
  // v4: bumped with bench-unfiltered-v7 (ledgerColumns).
  // v5: bumped with bench-unfiltered-v8 (sec unit).
  // v6: bumped with bench-unfiltered-v9 (bp unit).
  // v7: bumped with bench-unfiltered-v10 (dimensions overlay).
  // v8: bumped with bench-unfiltered-v11 (egress reduction).
  ["bench-filters-v8"],
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



