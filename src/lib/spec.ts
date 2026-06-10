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

import { promises as fs } from "node:fs";
import path from "node:path";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import yaml from "js-yaml";
import type {
  Benchmark,
  CellRankEntry,
  MetricPanel,
  ProviderResult,
} from "@/types/benchmark";
import { Prometheus } from "@/lib/prometheus";
import { SpecSchema, type Spec } from "@/lib/spec-schema";
import { renderBenchmarkText } from "@/lib/bench-template";
import { liveResults as liveProviderResults } from "@/lib/provider-filters";
import {
  readSnapshot,
  snapshotFromBenchmark,
  writeSnapshot,
} from "@/lib/snapshot";

export type { Spec } from "@/lib/spec-schema";

const SPECS_DIR = path.join(process.cwd(), "benchmarks");

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
    const promStart = Date.now();
    const bench = await specToBenchmark(spec);
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
  ["bench-unfiltered-v6"],
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
  ["all-benchmarks-v8"],
  { revalidate: 60, tags: ["benchmarks"] },
);
export const loadAllBenchmarks = cache(loadAllBenchmarksCached);

export type BenchmarkFilters = {
  chain?: string;
  region?: string;
  kind?: string;
};

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
  ["bench-filters-v3"],
  { revalidate: 60, tags: ["benchmarks"] }
);

function filterSig(f: BenchmarkFilters): string {
  // Stable ordering, ignore "all" / undefined which mean "no filter".
  const parts: string[] = [];
  for (const k of Object.keys(f).sort()) {
    const v = (f as Record<string, string | undefined>)[k];
    if (v && v !== "all") parts.push(`${k}=${v}`);
  }
  return parts.join("&");
}
function parseFilterSig(sig: string): BenchmarkFilters {
  const out: BenchmarkFilters = {};
  if (!sig) return out;
  for (const kv of sig.split("&")) {
    const [k, v] = kv.split("=");
    if (k && v && (k === "chain" || k === "region" || k === "kind")) {
      out[k as "chain" | "region" | "kind"] = v;
    }
  }
  return out;
}

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

const loadSpecs = cache(async (): Promise<Spec[]> => {
  let files: string[] = [];
  try {
    files = (await fs.readdir(SPECS_DIR)).filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml")
    );
  } catch {
    return [];
  }
  const parsed = await Promise.all(
    files.map(async (f) => {
      const raw = await fs.readFile(path.join(SPECS_DIR, f), "utf8");
      const result = SpecSchema.safeParse(yaml.load(raw));
      if (!result.success) {
        // CI catches this via `pnpm validate`. At runtime we skip and log.
        console.warn(`[spec] skipping ${f}:`, result.error.message);
        return null;
      }
      return result.data;
    })
  );
  return parsed.filter((s): s is Spec => s !== null);
});

function buildEditorial(
  spec: Spec,
): Omit<Benchmark, "results" | "extras" | "sampleSize" | "lastRunAt"> {
  return {
    slug: spec.slug,
    number: spec.number,
    title: spec.title,
    seoTitle: spec.seo_title,
    seoDescription: spec.seo_description,
    seoIntro: spec.seo_intro,
    disclaimer: spec.disclaimer,
    faq: spec.faq,
    perChainExplainer: spec.per_chain_explainer,
    subtitle: spec.subtitle,
    category: spec.category,
    status: spec.status,
    editorialStatus: spec.status,
    metric: spec.metric,
    unit: spec.unit,
    higherIsBetter: spec.higher_is_better,
    abstract: spec.abstract,
    methodology: spec.methodology,
    findings: spec.findings,
    source: spec.source,
    dimensions: spec.dimensions,
  };
}

// Used by the per-bench cache aggregator when a single bench fully fails
// (cold start + Prom blackout, no previous cache to preserve). Renders a
// draft placeholder so the page still works.
function draftPlaceholderForSpec(spec: Spec): Benchmark {
  return draftBenchmark(spec, buildEditorial(spec));
}

async function specToBenchmark(
  spec: Spec,
  options: BenchmarkFilters = {}
): Promise<Benchmark> {
  const editorial = buildEditorial(spec);

  const activeLabels = activeFilterLabels(options);
  const isFiltered = Object.keys(activeLabels).length > 0;
  const filteredSpec = isFiltered ? applyDimensionsToSpec(spec, activeLabels) : spec;

  const live = await tryLoadLive(filteredSpec, isFiltered);
  if (live) {
    // Mark live entries explicitly so a missing `availability` reads as
    // "unknown" everywhere else in the code.
    for (const r of live.results) r.availability = "live";

    // Augment with spec-declared providers that didn't return data this
    // cycle, but only on the *unfiltered* view. When the reader has
    // applied a dimension filter (e.g. chain=bnb on rpc-capabilities)
    // a no-data result almost always means the provider doesn't cover
    // that dimension at all (rpc-capabilities ships ~15 providers but
    // only 5 of them serve BNB; the other 10 are by-design absent on
    // that tab). Surfacing those as "Currently unavailable" rows would
    // pollute the leaderboard with 10 fake-offline entries and confuse
    // the reader about which providers are actually broken vs which
    // simply don't compete on this chain.
    //
    // On the unfiltered "All" tab we still augment because then a no-data
    // result really does mean "harness lost this provider"; product
    // pages also rely on the augmentation to stay reachable when the
    // upstream is briefly down.
    if (!isFiltered) {
      const liveSlugs = new Set(live.results.map((r) => r.slug.toLowerCase()));
      for (const p of spec.providers) {
        if (liveSlugs.has(p.slug.toLowerCase())) continue;
        live.results.push({
          name: p.name,
          slug: p.slug,
          tag: p.tag,
          type: p.type,
          layer: p.layer,
          ms: { p50: 0, p90: 0, p99: 0, mean: 0 },
          successRate: 0,
          secondary: p.secondary,
          availability: "unavailable",
          formula: p.formula,
        });
      }

      // Companion-metric backstop. The augmentation above marks any
      // provider whose headline `p50` query returned nothing as
      // "unavailable". On benches like hl-frontends where the headline
      // metric (effective fee bps) is legitimately empty for a builder
      // that had no fees in the rolling window but still routed real
      // volume, the same builder shows up live on the companion
      // panels (volume, fills/min, last fill age, taker share). Marking
      // it "unavailable" then is misleading: the reader switches to
      // the Volume panel, sees the line, then looks at the table and
      // reads "Currently unavailable" against a row that clearly has
      // data. Reclassify those to "live" so the row renders as a
      // first-class entry; the ledger still sorts it last because
      // ms.p50=0, but it stops claiming the provider is down.
      if (live.metricPanels && live.metricPanels.length > 0) {
        for (const r of live.results) {
          if (r.availability !== "unavailable") continue;
          const slug = r.slug.toLowerCase();
          const hasPanelData = live.metricPanels.some((panel) => {
            const v = panel.values?.[r.slug] ?? panel.values?.[slug];
            if (v != null && Number.isFinite(v)) return true;
            const series =
              panel.seriesByProvider?.[r.slug] ??
              panel.seriesByProvider?.[slug];
            return Array.isArray(series) && series.length > 0;
          });
          if (hasPanelData) r.availability = "live";
        }
      }
    }
    // Per-chain leaders/trailers: computed only on the unfiltered "All"
    // view of benches that declare `dimensions.chain`. Fan out one extra
    // tryLoadLive() per chain value (excluding "all") with the chain
    // label injected via applyDimensionsToSpec, then pick the live
    // leader + trailer for that chain. This powers the
    // `{{best_name:chain:X}}` placeholders + chain-aware OG/badge
    // surfaces. We deliberately don't augment unavailable providers
    // here: for per-chain leader we only care which provider actually
    // reported data on that chain. Failures are tolerated — a chain
    // with no Prom data just doesn't show up in bestPerChain.
    let bestPerChain: Record<string, ProviderResult> | undefined;
    let worstPerChain: Record<string, ProviderResult> | undefined;
    let providersPerChain: Record<string, string[]> | undefined;
    // Per-chain leaders/trailers/presence are computed ONLY on the
    // unfiltered view. Earlier this also ran for filtered variants to
    // populate {{best_name:chain:X}} in the variant's editorial copy,
    // but that quadrupled Prom load per page (3 extra queries × 9
    // pre-fetched variants on benches like aggregator-head-lag). The
    // filtered variants now inherit findings/faq/seoIntro from the
    // aggregate via the page-level fetch in app/benchmarks/[slug]/page.tsx,
    // so per-chain compute on filtered variants is no longer needed.
    if (!isFiltered && spec.dimensions?.chain && spec.dimensions.chain.length > 0) {
      const chainValues = spec.dimensions.chain
        .map((c) => c.value)
        .filter((v) => v !== "all");
      const perChainEntries = await Promise.all(
        chainValues.map(async (chain) => {
          const chainSpec = applyDimensionsToSpec(spec, { chain });
          const chainLive = await tryLoadLive(chainSpec, true);
          if (!chainLive) {
            return [chain, undefined, undefined, [] as string[]] as const;
          }
          for (const r of chainLive.results) r.availability = "live";
          const liveForChain = liveProviderResults(chainLive.results);
          const slugs = liveForChain.map((r) => r.slug);
          if (liveForChain.length === 0) {
            return [chain, undefined, undefined, slugs] as const;
          }
          const sorted = [...liveForChain].sort((a, b) =>
            spec.higher_is_better ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
          );
          return [
            chain,
            sorted[0],
            sorted[sorted.length - 1],
            slugs,
          ] as const;
        }),
      );
      const bests: Record<string, ProviderResult> = {};
      const worsts: Record<string, ProviderResult> = {};
      const providers: Record<string, string[]> = {};
      for (const [chain, leader, trailer, slugs] of perChainEntries) {
        if (leader) bests[chain] = leader;
        if (trailer) worsts[chain] = trailer;
        if (slugs.length > 0) providers[chain] = slugs;
      }
      if (Object.keys(bests).length > 0) bestPerChain = bests;
      if (Object.keys(worsts).length > 0) worstPerChain = worsts;
      if (Object.keys(providers).length > 0) providersPerChain = providers;
    }

    // Exact per-cell rankings (chain × region) from the spec's single
    // grouped matrix query. Failures are tolerated: badge/product
    // surfaces fall back to the coarser bestPerChain path.
    const cellRanks = !isFiltered ? await tryLoadCellRanks(spec) : undefined;

    // Resolve {{p50:slug}} / {{best_name}} / {{count}} etc. placeholders
    // against the freshly loaded numbers so editorial text (findings,
    // seo_intro, faq) never drifts from the displayed data.
    const rendered = renderBenchmarkText({
      ...editorial,
      ...live,
      bestPerChain,
      worstPerChain,
      providersPerChain,
      cellRanks,
    });
    // Persist a snapshot of the runtime data so a future cold start
    // during a Prom blackout can still render this bench. Only the
    // unfiltered "All" view is snapshotted: filtered variants (per
    // chain / region) are derived at request time from spec + filters.
    // No-op when KV isn't configured.
    if (!isFiltered && spec.status === "live") {
      writeSnapshot(spec.slug, snapshotFromBenchmark(rendered));
    }
    return rendered;
  }
  return draftBenchmark(spec, editorial);
}

function activeFilterLabels(opts: BenchmarkFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (v && v !== "all") out[k] = v;
  }
  return out;
}

/**
 * Run the spec's `rank_matrix_query` (one instant vector with a sample per
 * (provider[, chain][, region])) and fold it into full per-cell rankings.
 *
 * Output keys are `<chain>|<region>` with "all" standing in for an
 * undeclared dimension. When BOTH dimensions are declared, marginal cells
 * (`<chain>|all`, `all|<region>`) are derived by averaging a provider's
 * finest-cell values over the collapsed dimension — same semantics as the
 * bench page's unscoped `avg(...)` headline queries.
 *
 * Samples whose provider label doesn't match a spec provider slug, or
 * whose chain/region label isn't a declared dimension value, are dropped:
 * the matrix is unfiltered PromQL, so stray series (retired providers,
 * staging labels) must not leak into rankings.
 */
async function tryLoadCellRanks(
  spec: Spec,
): Promise<Record<string, CellRankEntry[]> | undefined> {
  if (!spec.rank_matrix_query) return undefined;
  const url = spec.prometheus?.url ?? process.env.PROMETHEUS_URL;
  if (!url) return undefined;
  try {
    const prom = new Prometheus(url);
    const res = await prom.query(spec.rank_matrix_query);
    if (res.resultType !== "vector") return undefined;

    const slugByLower = new Map(
      spec.providers.map((p) => [p.slug.toLowerCase(), p.slug] as const),
    );
    const chainValues = new Set(
      (spec.dimensions?.chain ?? []).map((c) => c.value).filter((v) => v !== "all"),
    );
    const regionValues = new Set(
      (spec.dimensions?.region ?? []).map((r) => r.value).filter((v) => v !== "all"),
    );

    // key → provider slug → samples (averaged if the grouping left
    // residual label splits, e.g. multiple replicas per region).
    const acc = new Map<string, Map<string, number[]>>();
    for (const sample of res.result) {
      const slug = slugByLower.get((sample.metric.provider ?? "").toLowerCase());
      if (!slug) continue;
      const chain = chainValues.size > 0 ? sample.metric.chain : undefined;
      const region = regionValues.size > 0 ? sample.metric.region : undefined;
      if (chainValues.size > 0 && (!chain || !chainValues.has(chain))) continue;
      if (regionValues.size > 0 && (!region || !regionValues.has(region))) continue;
      const v = Number(sample.value[1]);
      if (!Number.isFinite(v) || v <= 0) continue;
      const key = `${chain ?? "all"}|${region ?? "all"}`;
      const cell = acc.get(key) ?? new Map<string, number[]>();
      const vals = cell.get(slug) ?? [];
      vals.push(v);
      cell.set(slug, vals);
      acc.set(key, cell);
    }
    if (acc.size === 0) return undefined;

    const mean = (vals: number[]) =>
      vals.reduce((a, b) => a + b, 0) / vals.length;
    const sortCell = (cell: Map<string, number[]>): CellRankEntry[] =>
      [...cell.entries()]
        .map(([slug, vals]) => ({ slug, p50: mean(vals) }))
        .sort((a, b) =>
          spec.higher_is_better ? b.p50 - a.p50 : a.p50 - b.p50,
        );

    const out: Record<string, CellRankEntry[]> = {};
    for (const [key, cell] of acc) out[key] = sortCell(cell);

    // Marginals, only when both dimensions exist in the finest cells.
    if (chainValues.size > 0 && regionValues.size > 0) {
      const marginal = new Map<string, Map<string, number[]>>();
      for (const [key, cell] of acc) {
        const [chain, region] = key.split("|");
        for (const [slug, vals] of cell) {
          const v = mean(vals);
          for (const mKey of [`${chain}|all`, `all|${region}`]) {
            const mCell = marginal.get(mKey) ?? new Map<string, number[]>();
            const mVals = mCell.get(slug) ?? [];
            mVals.push(v);
            mCell.set(slug, mVals);
            marginal.set(mKey, mCell);
          }
        }
      }
      for (const [key, cell] of marginal) out[key] = sortCell(cell);
    }
    return out;
  } catch (e) {
    console.warn(
      `cellRanks skip: ${spec.slug} matrix query failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}

/** Inject every active `<label>="<value>"` into every PromQL label selector
 * across the spec's provider queries (including per-region subqueries).
 * Skips selectors that already filter by a given label. */
function applyDimensionsToSpec(spec: Spec, labels: Record<string, string>): Spec {
  const inject = (q: string | undefined) => (q ? injectLabels(q, labels) : q);
  return {
    ...spec,
    providers: spec.providers.map((p) => ({
      ...p,
      queries: p.queries
        ? {
            ...p.queries,
            p50: inject(p.queries.p50),
            p90: inject(p.queries.p90),
            p99: inject(p.queries.p99),
            mean: inject(p.queries.mean),
            success: inject(p.queries.success),
            sample_size: inject(p.queries.sample_size),
            series: inject(p.queries.series),
            regions: p.queries.regions?.map((r) => ({
              ...r,
              p50: inject(r.p50),
              series: inject(r.series),
            })),
          }
        : p.queries,
    })),
  };
}

export function injectLabels(query: string, labels: Record<string, string>): string {
  return query.replace(/\{([^}]*)\}/g, (_, inside: string) => {
    const additions: string[] = [];
    for (const [k, v] of Object.entries(labels)) {
      const present = new RegExp(`\\b${escapeRe(k)}\\s*=`).test(inside);
      if (!present) additions.push(`${k}="${escapePromLabelValue(v)}"`);
    }
    if (additions.length === 0) return `{${inside}}`;
    const trimmed = inside.trim();
    if (trimmed === "") return `{${additions.join(",")}}`;
    return `{${inside.replace(/\s*$/, "")},${additions.join(",")}}`;
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** PromQL label values are double-quoted strings. Escape backslash and
 *  double-quote so a URL-supplied filter value can never break out of the
 *  selector and inject extra label matchers. Newlines stripped for safety. */
function escapePromLabelValue(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, "");
}

async function tryLoadLive(
  spec: Spec,
  isFiltered = false
): Promise<Pick<Benchmark, "results" | "extras" | "sampleSize" | "lastRunAt" | "metricPanels"> | null> {
  const url = spec.prometheus?.url ?? process.env.PROMETHEUS_URL;
  if (!url) return null;
  const prom = new Prometheus(url);
  const winSec = parseDurationSec(spec.prometheus?.window ?? "24h") ?? 86_400;

  try {
    const liveResults: ProviderResult[] = [];
    const series24h: Record<string, number[]> = {};
    const series7d: Record<string, number[]> = {};
    const series30d: Record<string, number[]> = {};
    const seriesByRegion24h: Record<string, Record<string, number[]>> = {};
    const seriesByRegion7d: Record<string, Record<string, number[]>> = {};
    const seriesByRegion30d: Record<string, Record<string, number[]>> = {};
    const regions: Record<string, { region: string; p50: number }[]> = {};
    let totalSamples = 0;
    const sevenDaysSec = 7 * 86_400;
    const thirtyDaysSec = 30 * 86_400;

    for (const p of spec.providers) {
      const q = p.queries;
      if (!q) return null;

      const [p50, p90, p99, mean, success, sampleSize, slotP50, slotP99] = await Promise.all([
        q.p50 ? prom.scalar(q.p50) : Promise.resolve(null),
        q.p90 ? prom.scalar(q.p90) : Promise.resolve(null),
        q.p99 ? prom.scalar(q.p99) : Promise.resolve(null),
        q.mean ? prom.scalar(q.mean) : Promise.resolve(null),
        q.success ? prom.scalar(q.success) : Promise.resolve(null),
        q.sample_size ? prom.scalar(q.sample_size) : Promise.resolve(null),
        q.slot_p50 ? prom.scalar(q.slot_p50) : Promise.resolve(null),
        q.slot_p99 ? prom.scalar(q.slot_p99) : Promise.resolve(null),
      ]);

      // If a provider has no data for the current filter (e.g. Jupiter on
      // BNB Chain when Jupiter is Solana-only), skip it instead of failing
      // the whole benchmark. The page still renders with the providers
      // that do have numbers.
      //
      // Log which percentile came back null so transient AWAITING events
      // are diagnosable. The Prom-client only logs explicit errors (400,
      // timeout), not legitimately empty results, which is the most
      // common AWAITING trigger. Logged at warn level only on the
      // unfiltered "All" view to avoid spamming logs on filtered views
      // where a missing provider is expected behavior.
      if (p50 == null || p90 == null || p99 == null) {
        if (!isFiltered && spec.status === "live") {
          const missing = [
            p50 == null ? "p50" : null,
            p90 == null ? "p90" : null,
            p99 == null ? "p99" : null,
          ]
            .filter(Boolean)
            .join(",");
          console.warn(
            `bench skip: ${spec.slug}/${p.slug} missing ${missing}`,
          );
        }
        continue;
      }

      liveResults.push({
        name: p.name,
        slug: p.slug,
        tag: p.tag,
        type: p.type,
        layer: p.layer,
        ms: { p50, p90, p99, mean: mean ?? p50 },
        slots:
          slotP50 != null && slotP99 != null
            ? { p50: slotP50, p99: slotP99 }
            : undefined,
        successRate: success != null ? (success > 1 ? success : success * 100) : 100,
        sampleSize: sampleSize ?? undefined,
        secondary: p.secondary,
        query: q.p50,
        formula: p.formula,
      });

      if (q.series) {
        const [s24, s7, s30] = await Promise.all([
          prom.series(q.series, winSec, 72),
          prom.series(q.series, sevenDaysSec, 84),
          prom.series(q.series, thirtyDaysSec, 60),
        ]);
        if (s24 && s24.length > 0) series24h[p.slug] = s24;
        if (s7 && s7.length > 0) series7d[p.slug] = s7;
        if (s30 && s30.length > 0) series30d[p.slug] = s30;
      }

      if (q.regions && q.regions.length > 0) {
        const points = await Promise.all(
          q.regions.map(async (r) => {
            const [p50Val, regionSeries24, regionSeries7, regionSeries30] = await Promise.all([
              r.p50 ? prom.scalar(r.p50) : Promise.resolve(p50),
              r.series ? prom.series(r.series, winSec, 72) : Promise.resolve(null),
              r.series ? prom.series(r.series, sevenDaysSec, 84) : Promise.resolve(null),
              r.series ? prom.series(r.series, thirtyDaysSec, 60) : Promise.resolve(null),
            ]);
            return {
              region: r.region,
              p50: p50Val ?? p50,
              series24: regionSeries24,
              series7: regionSeries7,
              series30: regionSeries30,
            };
          })
        );
        regions[p.slug] = points.map(({ region: rg, p50: v }) => ({ region: rg, p50: v }));
        for (const pt of points) {
          if (pt.series24 && pt.series24.length > 0) {
            (seriesByRegion24h[p.slug] ??= {})[pt.region] = pt.series24;
          }
          if (pt.series7 && pt.series7.length > 0) {
            (seriesByRegion7d[p.slug] ??= {})[pt.region] = pt.series7;
          }
          if (pt.series30 && pt.series30.length > 0) {
            (seriesByRegion30d[p.slug] ??= {})[pt.region] = pt.series30;
          }
        }
      }

      if (sampleSize) totalSamples += sampleSize;
    }

    // No live numbers from anyone (every provider was skipped) → draft.
    if (liveResults.length === 0) return null;

    // Optional companion metric panels. Each panel declares one Prometheus
    // metric; we query it per provider (`<metric>{<label_key>="<slug>"}`)
    // and store the scalar values. Providers with no data for that metric
    // are omitted from the values map (rendered as "no data" by the UI).
    const metricPanels: MetricPanel[] = [];
    for (const panel of spec.metric_panels ?? []) {
      const values: Record<string, number> = {};
      const seriesByProvider: Record<string, number[]> = {};
      const seriesByProvider7d: Record<string, number[]> = {};
      const seriesByProvider30d: Record<string, number[]> = {};
      await Promise.all(
        spec.providers.map(async (p) => {
          const sel = `${panel.label_key}="${escapePromLabelValue(p.slug)}"`;
          const q = panel.metric.includes("{")
            ? panel.metric.replace("{", `{${sel},`)
            : `${panel.metric}{${sel}}`;
          const [v, s24, s7, s30] = await Promise.all([
            prom.scalar(q),
            prom.series(q, winSec, 72),
            prom.series(q, sevenDaysSec, 84),
            prom.series(q, thirtyDaysSec, 60),
          ]);
          if (v != null && Number.isFinite(v)) values[p.slug] = v;
          if (s24 && s24.length > 0) seriesByProvider[p.slug] = s24;
          if (s7 && s7.length > 0) seriesByProvider7d[p.slug] = s7;
          if (s30 && s30.length > 0) seriesByProvider30d[p.slug] = s30;
        })
      );
      metricPanels.push({
        id: panel.id,
        label: panel.label,
        description: panel.description,
        metric: panel.metric,
        unit: panel.unit,
        higherIsBetter: panel.higher_is_better,
        values,
        seriesByProvider,
        seriesByProvider7d:
          Object.keys(seriesByProvider7d).length > 0 ? seriesByProvider7d : undefined,
        seriesByProvider30d:
          Object.keys(seriesByProvider30d).length > 0 ? seriesByProvider30d : undefined,
      });
    }

    // Derive lastRunAt from the actual Prom data freshness. We probe the
    // first provider that has a p50 query and ask Prom for the age of
    // its underlying metric. This is consistent across pages (Prom is the
    // single source of truth) and reflects real data freshness instead of
    // ISR cache age. Falls back to `now` only when extraction fails.
    let lastRunAt = new Date().toISOString();
    for (const p of spec.providers) {
      const q = p.queries?.p50;
      if (!q) continue;
      const ageSec = await prom.dataAgeSec(q);
      if (ageSec != null && Number.isFinite(ageSec) && ageSec >= 0) {
        lastRunAt = new Date(Date.now() - Math.floor(ageSec * 1000)).toISOString();
        break;
      }
    }

    return {
      results: liveResults,
      extras: {
        series24h,
        series7d: Object.keys(series7d).length > 0 ? series7d : undefined,
        series30d: Object.keys(series30d).length > 0 ? series30d : undefined,
        seriesByRegion24h:
          Object.keys(seriesByRegion24h).length > 0 ? seriesByRegion24h : undefined,
        seriesByRegion7d:
          Object.keys(seriesByRegion7d).length > 0 ? seriesByRegion7d : undefined,
        seriesByRegion30d:
          Object.keys(seriesByRegion30d).length > 0 ? seriesByRegion30d : undefined,
        regions: regions as Benchmark["extras"]["regions"],
      },
      metricPanels: metricPanels.length > 0 ? metricPanels : undefined,
      sampleSize: totalSamples,
      lastRunAt,
    };
  } catch {
    return null;
  }
}

function draftBenchmark(
  spec: Spec,
  editorial: Omit<Benchmark, "results" | "extras" | "sampleSize" | "lastRunAt">
): Benchmark {
  // Render the page even when Prometheus has no data yet. the editorial
  // metadata is still useful, and the results section shows "awaiting first
  // run" so readers know what's happening.
  const results: ProviderResult[] = spec.providers.map((p) => ({
    name: p.name,
    slug: p.slug,
    tag: p.tag,
    type: p.type,
    layer: p.layer,
    ms: { p50: 0, p90: 0, p99: 0, mean: 0 },
    successRate: 0,
    secondary: p.secondary,
    formula: p.formula,
  }));
  return {
    ...editorial,
    status: "draft",
    results,
    extras: { series24h: {}, regions: {} },
    sampleSize: 0,
    lastRunAt: new Date().toISOString(),
  };
}

function parseDurationSec(d: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(d.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  return n * { s: 1, m: 60, h: 3600, d: 86_400 }[unit as "s" | "m" | "h" | "d"];
}

/**
 * Lookup helper for the per-chain leader stash. Returns the ProviderResult
 * that leads on `chain` (e.g. "solana"), or undefined when the bench
 * doesn't declare chain dimensions, when the chain isn't in the spec, or
 * when no live data was collected for that chain this cycle.
 *
 * Consumed by the chain-aware template placeholders (bench-template.ts),
 * the chain-aware OG image / badge endpoints (SEO + API surfaces), and
 * the products pages that want to call out a chain-specific winner
 * instead of the biased unfiltered aggregate.
 */
export function bestForChain(
  b: Benchmark,
  chain: string,
): ProviderResult | undefined {
  return b.bestPerChain?.[chain];
}
