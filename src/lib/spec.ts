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
    if (stored) return stored;
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
  ["bench-unfiltered-v9"],
  { revalidate: 60, tags: ["benchmarks"] },
);

// Aggregator: fan out to N per-bench caches in parallel via
// Promise.allSettled so a single bench's transient throw doesn't bring
// down the whole list. For specs whose per-bench cache is empty AND the
// fresh fetch threw (cold-start blackout case), we fall back to a draft
// placeholder so the page renders. The OG "all benches draft" safety
// throw is preserved: if literally every bench resolves to draft we
// throw to keep the previous all-benches cache intact.
const loadAllBenchmarksCached = unstable_cache(
  async (): Promise<Benchmark[]> => {
    const specs = await loadSpecs();
    const settled = await Promise.allSettled(
      specs.map((s) => loadBenchmarkUnfilteredCached(s.slug)),
    );
    const benchmarks: Benchmark[] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const r = settled[i];
      if (r.status === "fulfilled" && r.value) {
        benchmarks.push(r.value);
      } else {
        // The per-bench throw fired with no previous cache to fall back
        // to. Surface a placeholder so the page still renders rather
        // than dropping the bench from the list (which would break the
        // sitemap, the products pages, and the "More benchmarks" rail).
        // [DRAFT-TRACE] this is the path that produces a visible "draft"
        // render to the user — log so we can correlate with KV / prom state.
        const reason =
          r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : "no_value";
        console.warn(
          `[DRAFT-TRACE] placeholder_used slug=${spec.slug} reason=${reason}`,
        );
        benchmarks.push(draftPlaceholderForSpec(spec));
      }
    }
    const live = benchmarks.filter((b) => b.status === "live");
    if (benchmarks.length > 0 && live.length === 0) {
      // Previously this threw to make unstable_cache keep the previous
      // value during a Prom blackout. The throw, however, propagates
      // unhandled into the BUILD-time page-generation path (no previous
      // cache there) and crashes `next build` with "Error: every bench
      // draft". With the snapshot/KV fallback + 10s Prom timeout + cron
      // pre-warm now in place, this safety net mostly fires during the
      // build window of a cold deploy. Warn loudly and return the
      // draft set — the page renders with placeholders and recovers on
      // the next revalidate cycle. Avoids deploy crashes.
      console.warn(
        "[DRAFT-TRACE] all_draft slug_count=" + benchmarks.length +
          " — Prom blackout during build/cold-start, returning placeholders",
      );
    }
    return benchmarks.sort((a, b) => a.number.localeCompare(b.number));
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
  ["all-benchmarks-v11"],
  { revalidate: 60, tags: ["benchmarks"] },
);
export const loadAllBenchmarks = cache(loadAllBenchmarksCached);


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
    if (stored) return stored;
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
  ["bench-filters-v6"],
  { revalidate: 60, tags: ["benchmarks"] }
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
    const all = await loadAllBenchmarks();
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
    return await loadBenchmarkFiltered(slug, sig);
  } catch {
    const all = await loadAllBenchmarks();
    return all.find((b) => b.slug === slug);
  }
});

export const getSpecs = (): Promise<Spec[]> => loadSpecs();

const loadSpecs = cache(loadSpecsUncached);



