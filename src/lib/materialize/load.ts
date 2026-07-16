/**
 * Next-free benchmark loader core.
 *
 * Everything here runs in BOTH contexts: the Next.js site (wrapped in
 * unstable_cache layers by src/lib/spec.ts) and the standalone
 * materialization worker on Railway (which imports this directly and
 * must never pull next/* into its bundle). Do not import next/react
 * here; persistence side effects are injected via hooks.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type {
  Benchmark,
  CellRankEntry,
  MetricPanel,
  ProviderResult,
} from "@/types/benchmark";
import { Prometheus } from "@/lib/prometheus";
import { SpecSchema, type Spec } from "@/lib/spec-schema";
import { REMOVED_BENCH_SLUGS } from "@/lib/removed-benches";
import { renderBenchmarkText } from "@/lib/bench-template";
import { liveResults as liveProviderResults } from "@/lib/provider-filters";
import {
  classifyHealth,
  aggregateConfidence,
} from "@/lib/sample-health";

/** Overridable so the worker can run with a different cwd. */
const SPECS_DIR =
  process.env.OCB_SPECS_DIR ?? path.join(process.cwd(), "benchmarks");

/** Side-effect hooks injected by the caller (site: KV snapshot write;
 *  worker: store publish). Keeps this module free of persistence deps. */
export type LoadHooks = {
  /** Called with the rendered bench after a successful UNFILTERED live
   *  load of a live spec. Not called for filtered variants or drafts. */
  onRendered?: (b: Benchmark) => void;
};

export type BenchmarkFilters = {
  chain?: string;
  region?: string;
  kind?: string;
  venue?: string;
};

export function filterSig(f: BenchmarkFilters): string {
  // Stable ordering, ignore "all" / undefined which mean "no filter".
  const parts: string[] = [];
  for (const k of Object.keys(f).sort()) {
    const v = (f as Record<string, string | undefined>)[k];
    if (v && v !== "all") parts.push(`${k}=${v}`);
  }
  return parts.join("&");
}
export function parseFilterSig(sig: string): BenchmarkFilters {
  const out: BenchmarkFilters = {};
  if (!sig) return out;
  for (const kv of sig.split("&")) {
    const [k, v] = kv.split("=");
    if (k && v && (k === "chain" || k === "region" || k === "kind" || k === "venue")) {
      out[k as "chain" | "region" | "kind" | "venue"] = v;
    }
  }
  return out;
}
// Module-level memo. Spec YAMLs are immutable for the lifetime of a
// deployment (Vercel lambda) or worker container, but the React cache()
// wrapper around this loader is a no-op inside unstable_cache callbacks
// — so the catalog aggregate was re-reading all spec files once PER
// BENCH, in parallel. At 57 specs that is ~57×57 concurrent opens and
// the lambda dies with EMFILE ("too many open files"), collapsing
// /api/citable and the sitemap to drafts (2026-07-04 incident, first
// triggered by growing the catalog from 45 to 57 specs).
let specsMemo: Promise<Spec[]> | null = null;

export function loadSpecsUncached(): Promise<Spec[]> {
  specsMemo ??= loadSpecsFromDisk().catch((err) => {
    // Never memoize a failure: a transient fs error would otherwise
    // poison every subsequent load for the lambda's lifetime.
    specsMemo = null;
    throw err;
  });
  return specsMemo;
}

async function loadSpecsFromDisk(): Promise<Spec[]> {
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
  const specs = parsed.filter((s): s is Spec => s !== null);
  // Prod-only gate: staging-pipeline benches never reach the prod
  // catalog, hubs, feeds or citable API. Direct URL hits get a 410
  // from middleware. Staging/preview/dev render everything.
  if (process.env.VERCEL_ENV === "production") {
    return specs.filter((s) => !REMOVED_BENCH_SLUGS.has(s.slug));
  }
  return specs;
}

export function buildEditorial(
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
    panelMainLabel: spec.panel_main_label,
    unit: spec.unit,
    higherIsBetter: spec.higher_is_better,
    abstract: spec.abstract,
    methodology: spec.methodology,
    findings: spec.findings,
    source: spec.source,
    dimensions: spec.dimensions,
    ledgerColumns: spec.ledger_columns,
    providerNotes: spec.provider_notes,
  };
}

// Used by the per-bench cache aggregator when a single bench fully fails
// (cold start + Prom blackout, no previous cache to preserve). Renders a
// draft placeholder so the page still works.
export function draftPlaceholderForSpec(spec: Spec): Benchmark {
  return draftBenchmark(spec, buildEditorial(spec));
}

export async function specToBenchmark(
  spec: Spec,
  options: BenchmarkFilters = {},
  hooks?: LoadHooks,
): Promise<Benchmark> {
  const editorial = buildEditorial(spec);

  const activeLabels = activeFilterLabels(options);
  const isFiltered = Object.keys(activeLabels).length > 0;
  const filteredSpec = isFiltered ? applyDimensionsToSpec(spec, activeLabels) : spec;

  const live = await tryLoadLive(filteredSpec, isFiltered);
  if (live) {
    // Mark live entries explicitly so a missing `availability` reads as
    // "unknown" everywhere else in the code. Unresponsive rows keep
    // their "unavailable" marker so no ranking surface counts them.
    for (const r of live.results) {
      if (!r.unresponsive) r.availability = "live";
    }

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
          // Never promote unresponsive rows: their call counters ARE
          // panel-shaped data on some benches, but a 0-2% success rate
          // is exactly the condition the badge exists to surface.
          if (r.unresponsive) continue;
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
          for (const r of chainLive.results) {
            if (!r.unresponsive) r.availability = "live";
          }
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

    // Per-provider sample-health classification. When the spec declares
    // expected_n, every live provider gets `dataConfidence` (healthy /
    // low / insufficient) + `sampleHealth` (raw ratio) so the renderer
    // can badge undersized rows and so citable APIs can refuse to crown
    // a leader drawn from a degraded sample. Bench-wide aggregate is
    // the median of the per-provider classifications.
    const expectedN = spec.expected_n;
    if (expectedN) {
      for (const r of live.results) {
        // Unresponsive rows carry a full probe count (the calls run,
        // they just fail) — classifying them "healthy" would read as a
        // contradiction next to the badge, and aggregateConfidence
        // already skips unavailable rows. Leave them unclassified.
        if (r.unresponsive) continue;
        const h = classifyHealth(r.sampleSize, expectedN);
        if (h) {
          r.dataConfidence = h.confidence;
          r.sampleHealth = h.ratio;
        }
      }
    }
    const agg = expectedN
      ? aggregateConfidence(live.results, expectedN)
      : undefined;

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
      expectedN,
      dataConfidence: agg?.confidence,
    });
    // Persistence is the caller's concern (site: KV snapshot write,
    // worker: store publish). Only the unfiltered "All" view of a live
    // spec triggers the hook; filtered variants are derived views.
    if (!isFiltered && spec.status === "live") {
      hooks?.onRendered?.(rendered);
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
 * Nullify every bucket in `coarse` whose covering time-range overlaps
 * a null bucket in `fine`. Both series are dense right-anchored ("now"
 * = last index), so index i in a series of length N maps to time-ago
 * (N - 1 - i) / (N - 1) of the window. Each contiguous null RUN on the
 * fine grid nulls every coarse bucket its range straddles, so a short
 * outage detected on the 24h grid stays visible as a contiguous band
 * on the 7d and 30d grids (not two neighbouring pills).
 *
 * No-op when either input is missing or too short. Mutates `coarse`.
 * Exported for tests.
 */
export function propagateNullsToCoarser(
  fine: (number | null)[] | null | undefined,
  fineWindowSec: number,
  coarse: (number | null)[] | null | undefined,
  coarseWindowSec: number,
): void {
  if (!fine || !coarse || fine.length < 2 || coarse.length < 2) return;
  if (fineWindowSec <= 0 || coarseWindowSec <= 0) return;
  const fineStep = fineWindowSec / (fine.length - 1);
  const coarseStep = coarseWindowSec / (coarse.length - 1);
  // Right-anchored: last index = now. Map a fine index to the same
  // ABSOLUTE time-ago on the coarse grid (both grids share "now"; the
  // step sizes are what differ, not the reference point). Previous
  // math scaled by the fine window fraction, which shrank a 7 h ago
  // outage down to 40 h ago once projected onto the 7 d grid.
  const toIdxCoarse = (i: number): number => {
    const secondsAgo = (fine.length - 1 - i) * fineStep;
    return (coarse.length - 1) - secondsAgo / coarseStep;
  };
  let runStart: number | null = null;
  const closeRun = (endExclusive: number) => {
    if (runStart == null) return;
    const startX = toIdxCoarse(runStart);
    const endX = toIdxCoarse(endExclusive);
    const lo = Math.max(0, Math.floor(Math.min(startX, endX)));
    const hi = Math.min(coarse.length - 1, Math.ceil(Math.max(startX, endX)));
    for (let k = lo; k <= hi; k++) coarse[k] = null;
    runStart = null;
  };
  for (let i = 0; i < fine.length; i++) {
    if (fine[i] === null) {
      if (runStart == null) runStart = i;
    } else {
      closeRun(i);
    }
  }
  closeRun(fine.length);
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
    // Canonical dimension value by lowercase, so a harness emitting
    // `chain="Base"` still maps onto the declared `base` value instead
    // of silently dropping the cell.
    const chainByLower = new Map(
      (spec.dimensions?.chain ?? [])
        .filter((c) => c.value !== "all")
        .map((c) => [c.value.toLowerCase(), c.value] as const),
    );
    const regionByLower = new Map(
      (spec.dimensions?.region ?? [])
        .filter((r) => r.value !== "all")
        .map((r) => [r.value.toLowerCase(), r.value] as const),
    );

    // key → provider slug → samples (averaged if the grouping left
    // residual label splits, e.g. multiple replicas per region).
    const acc = new Map<string, Map<string, number[]>>();
    for (const sample of res.result) {
      const slug = slugByLower.get((sample.metric.provider ?? "").toLowerCase());
      if (!slug) continue;
      const chain =
        chainByLower.size > 0
          ? chainByLower.get((sample.metric.chain ?? "").toLowerCase())
          : undefined;
      const region =
        regionByLower.size > 0
          ? regionByLower.get((sample.metric.region ?? "").toLowerCase())
          : undefined;
      if (chainByLower.size > 0 && !chain) continue;
      if (regionByLower.size > 0 && !region) continue;
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
    // A provider only enters a marginal if it covers EVERY cell of the
    // collapsed dimension that exists for that row/column. Without this,
    // a provider measured only from its fastest region wins the
    // `<chain>|all` average by omission (Simpson's bias), and the badge
    // for "leads chain X" disagrees with the per-cell wins that earned it.
    if (chainByLower.size > 0 && regionByLower.size > 0) {
      const regionsOfChain = new Map<string, Set<string>>();
      const chainsOfRegion = new Map<string, Set<string>>();
      for (const key of acc.keys()) {
        const [chain, region] = key.split("|");
        (regionsOfChain.get(chain) ?? regionsOfChain.set(chain, new Set()).get(chain)!).add(region);
        (chainsOfRegion.get(region) ?? chainsOfRegion.set(region, new Set()).get(region)!).add(chain);
      }
      const marginalFor = (
        groups: Map<string, Set<string>>,
        keyOf: (group: string, member: string) => string,
        mKeyOf: (group: string) => string,
      ) => {
        for (const [group, members] of groups) {
          const cell = new Map<string, number[]>();
          // Providers present in every member cell of the group.
          let eligible: Set<string> | undefined;
          for (const member of members) {
            const slugs = new Set(acc.get(keyOf(group, member))?.keys() ?? []);
            eligible = eligible
              ? new Set([...eligible].filter((s) => slugs.has(s)))
              : slugs;
          }
          for (const slug of eligible ?? []) {
            const vals: number[] = [];
            for (const member of members) {
              const v = acc.get(keyOf(group, member))?.get(slug);
              if (v) vals.push(mean(v));
            }
            if (vals.length > 0) cell.set(slug, [mean(vals)]);
          }
          if (cell.size > 0) out[mKeyOf(group)] = sortCell(cell);
        }
      };
      marginalFor(
        regionsOfChain,
        (chain, region) => `${chain}|${region}`,
        (chain) => `${chain}|all`,
      );
      marginalFor(
        chainsOfRegion,
        (region, chain) => `${chain}|${region}`,
        (region) => `all|${region}`,
      );
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
    // Panels declare a bare metric name (or metric{sel}); normalize to the
    // braced form so dimension labels (chain=..., region=...) reach them
    // like every provider query. Without this a panel on a chain-dimensioned
    // bench silently mixes every chain's series.
    metric_panels: spec.metric_panels?.map((panel) => ({
      ...panel,
      metric: injectLabels(
        panel.metric.includes("{") ? panel.metric : `${panel.metric}{}`,
        labels,
      ),
    })),
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
            live_activity: inject(p.queries.live_activity),
            regions: p.queries.regions?.map((r) => ({
              ...r,
              p50: inject(r.p50),
              series: inject(r.series),
            })),
          }
        : p.queries,
    })),
    prometheus: spec.prometheus
      ? { ...spec.prometheus, probe_ok: inject(spec.prometheus.probe_ok) }
      : spec.prometheus,
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

/** Success-rate ceiling (in percent) under which a latency-less cohort
 *  member is classified "unresponsive" rather than transiently
 *  unreadable. Latency percentiles come from the same probes as OK
 *  results (the harness only records latency for successful calls), so
 *  any real success share implies the latency series exists — a null
 *  percentile next to a healthy success rate is a transient Prom read
 *  failure, not a dead endpoint, and must not be badged. */
const UNRESPONSIVE_MAX_SUCCESS_PCT = 5;

/**
 * Build the unranked "unresponsive" entry for a spec-declared provider
 * whose latency percentiles returned nothing this cycle. Returns null
 * when the provider wasn't provably probed in the current view (no
 * success sample AND no call-count sample), which keeps the behavior
 * scoped to specs that declare reliability queries (the RPC family):
 * benches without `success` / `sample_size` queries never produce these
 * rows, and chain/region variants only flag providers whose counters
 * actually exist on that slice (a provider that simply doesn't cover
 * the filtered chain stays absent, not fake-offline).
 *
 * Exported for unit tests.
 */
export function unresponsiveResult(
  p: Spec["providers"][number],
  probe: { success: number | null; sampleSize: number | null },
): ProviderResult | null {
  const probed =
    (probe.sampleSize != null && probe.sampleSize > 0) || probe.success != null;
  if (!probed) return null;
  // Same ratio-vs-percent normalization as the live path. A missing
  // success sample with live call counters means the ok-rate series is
  // entirely absent (zero successful probes in the window) → 0%.
  const successPct =
    probe.success != null
      ? probe.success > 1
        ? probe.success
        : probe.success * 100
      : 0;
  if (successPct >= UNRESPONSIVE_MAX_SUCCESS_PCT) return null;
  return {
    name: p.name,
    slug: p.slug,
    tag: p.tag,
    type: p.type,
    layer: p.layer,
    ms: { p50: 0, p90: 0, p99: 0, mean: 0 },
    successRate: successPct,
    sampleSize: probe.sampleSize ?? undefined,
    secondary: p.secondary,
    availability: "unavailable",
    unresponsive: true,
    formula: p.formula,
  };
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
    const series24h: Record<string, (number | null)[]> = {};
    const series7d: Record<string, (number | null)[]> = {};
    const series30d: Record<string, (number | null)[]> = {};
    const seriesByRegion24h: Record<string, Record<string, (number | null)[]>> = {};
    const seriesByRegion7d: Record<string, Record<string, (number | null)[]>> = {};
    const seriesByRegion30d: Record<string, Record<string, (number | null)[]>> = {};
    const regions: Record<string, { region: string; p50: number }[]> = {};
    let totalSamples = 0;
    const sevenDaysSec = 7 * 86_400;
    const thirtyDaysSec = 30 * 86_400;

    // Bench-level "is our end fine" gate. Fetched once per sweep; feeds
    // every provider's liveStatus verdict below so a broken harness / Prom
    // scrape can't fake-flag every provider as down at once. Absent when
    // the spec doesn't declare probe_ok — in which case we trust each
    // provider's live_activity unconditionally.
    const probeOkQuery = spec.prometheus?.probe_ok;
    const probeOk = probeOkQuery
      ? await prom.scalar(probeOkQuery)
      : null;
    // Interpret: >0 or null-when-not-declared → trust per-provider verdicts.
    // Explicit 0 (or NaN) → the probe itself is down; suppress all badges.
    const trustLiveVerdicts = !probeOkQuery || (probeOk != null && probeOk > 0);

    for (const p of spec.providers) {
      const q = p.queries;
      if (!q) return null;

      let [p50, p90, p99] = await Promise.all([
        q.p50 ? prom.scalar(q.p50) : Promise.resolve(null),
        q.p90 ? prom.scalar(q.p90) : Promise.resolve(null),
        q.p99 ? prom.scalar(q.p99) : Promise.resolve(null),
      ]);
      const [mean, success, sampleSize, slotP50, slotP99, liveActivity] = await Promise.all([
        q.mean ? prom.scalar(q.mean) : Promise.resolve(null),
        q.success ? prom.scalar(q.success) : Promise.resolve(null),
        q.sample_size ? prom.scalar(q.sample_size) : Promise.resolve(null),
        q.slot_p50 ? prom.scalar(q.slot_p50) : Promise.resolve(null),
        q.slot_p99 ? prom.scalar(q.slot_p99) : Promise.resolve(null),
        q.live_activity ? prom.scalar(q.live_activity) : Promise.resolve(null),
      ]);

      // One retry on the load-bearing percentiles. A null here is either
      // "provider has no data" (retry returns null again, harmless) or a
      // transient Prom timeout under burst load (retry usually lands now
      // that the concurrency cap has drained the burst). This is the
      // difference between a provider flickering off the leaderboard for
      // 60s and a stable board. Unfiltered view only: on chain/region
      // tabs a null usually means the provider structurally isn't on
      // that slice, and retrying every absent provider on every variant
      // would triple the query bill for nothing.
      if (!isFiltered && (p50 == null || p90 == null || p99 == null) && q.p50 && q.p90 && q.p99) {
        const [r50, r90, r99] = await Promise.all([
          p50 == null ? prom.scalar(q.p50) : Promise.resolve(p50),
          p90 == null ? prom.scalar(q.p90) : Promise.resolve(p90),
          p99 == null ? prom.scalar(q.p99) : Promise.resolve(p99),
        ]);
        p50 = r50;
        p90 = r90;
        p99 = r99;
      }

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
        // Unresponsive cohort member: the latency series is gone from
        // the window (failed probes record no latency, so a fully dead
        // endpoint's percentiles go Prom-stale within 24h) but the call
        // counters still prove probing continues. Keep the provider on
        // the board as an unranked "unresponsive" row carrying its
        // success rate + sample size instead of silently vanishing.
        // Applies to filtered (region) variants too — the injected
        // labels make the counters view-scoped, so a provider dead in
        // only one region is flagged on that region's tab while ranking
        // normally everywhere it still answers.
        const unresponsive = unresponsiveResult(p, { success, sampleSize });
        if (unresponsive) {
          liveResults.push(unresponsive);
          if (sampleSize) totalSamples += sampleSize;
          continue;
        }
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

      // liveStatus: only computed when the spec declares live_activity.
      // "unknown" wins whenever we can't tell (probe_ok says our side is
      // broken, or the activity query returned no sample) — never falls
      // through to "down" on ambiguous data, since a false red pill on
      // a live provider is worse than a missing pill on a real outage.
      let liveStatus: "healthy" | "down" | "unknown" | undefined;
      if (q.live_activity) {
        if (!trustLiveVerdicts || liveActivity == null) {
          liveStatus = "unknown";
        } else if (liveActivity > 0) {
          liveStatus = "healthy";
        } else {
          liveStatus = "down";
        }
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
        liveStatus,
      });

      if (q.series) {
        const [s24, s7, s30] = await Promise.all([
          prom.series(q.series, winSec, 72),
          prom.series(q.series, sevenDaysSec, 84),
          prom.series(q.series, thirtyDaysSec, 60),
        ]);
        // Propagate short outages captured on the fine 24h grid up to
        // the coarser 7d/30d grids. Only when the bench opted in via
        // `live_activity` — other benches carry natural nulls (sparse
        // scrapes, backfill edges) that shouldn't fire a "DATA MISSING"
        // pill on the chart.
        if (q.live_activity && s24 && s24.length > 0) {
          propagateNullsToCoarser(s24, winSec, s7, sevenDaysSec);
          propagateNullsToCoarser(s24, winSec, s30, thirtyDaysSec);
        }
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
          // Same short-outage propagation as the global series above.
          if (q.live_activity && pt.series24 && pt.series24.length > 0) {
            propagateNullsToCoarser(pt.series24, winSec, pt.series7, sevenDaysSec);
            propagateNullsToCoarser(pt.series24, winSec, pt.series30, thirtyDaysSec);
          }
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
    // Unresponsive rows don't count: a board made ONLY of dead providers
    // has no ranking to publish, and letting them satisfy the check
    // would also let them satisfy the quorum guard below during a Prom
    // brownout (counters often survive a partial outage that kills the
    // heavier percentile queries).
    const rankedCount = liveResults.filter((r) => !r.unresponsive).length;
    if (rankedCount === 0) return null;

    // Quorum guard. Providers whose p50/p90/p99 come back null are
    // silently skipped above, which is correct for a single flaky source
    // but catastrophic under a Prom brownout: 14 of 15 providers timing
    // out still yielded a "live" render with one bar on the leaderboard,
    // which then got cached for 60s AND overwrote the KV snapshot with
    // the degraded set. Treat a sub-quorum unfiltered render as a failed
    // cycle instead: returning null makes the live-spec path throw, so
    // unstable_cache keeps the last good render (or falls back to the KV
    // snapshot on cold start). Filtered views are exempt — a chain tab
    // legitimately has fewer providers than the spec declares.
    if (!isFiltered) {
      const declared = spec.providers.filter((p) => p.queries).length;
      // Floor at 3 so a bench whose field is legitimately decimated (most
      // declared providers dead for days) can still go live with its
      // survivors instead of drafting forever once the KV snapshot ages
      // out. 3 is still enough to make a leaderboard meaningful, and the
      // brownout scenario this guards against (1-2 stragglers passing
      // while the rest time out) stays caught.
      const quorum = Math.min(Math.ceil(declared / 2), 3);
      if (rankedCount < quorum) {
        console.warn(
          `bench quorum fail: ${spec.slug} live=${rankedCount}/${declared} → keeping previous render`,
        );
        return null;
      }
    }

    // Optional companion metric panels. Each panel declares one Prometheus
    // metric; we query it per provider (`<metric>{<label_key>="<slug>"}`)
    // and store the scalar values. Providers with no data for that metric
    // are omitted from the values map (rendered as "no data" by the UI).
    const metricPanels: MetricPanel[] = [];
    for (const panel of spec.metric_panels ?? []) {
      const values: Record<string, number> = {};
      const seriesByProvider: Record<string, (number | null)[]> = {};
      const seriesByProvider7d: Record<string, (number | null)[]> = {};
      const seriesByProvider30d: Record<string, (number | null)[]> = {};
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
        tab: panel.tab,
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
    //
    // Benches reading ocb:* recorded series MUST declare
    // prometheus.freshness_metric (the raw harness metric): a recording
    // rule keeps emitting fresh samples from its 24h window for a full
    // day after the harness dies, so probing the recorded series would
    // mask the outage.
    let lastRunAt = new Date().toISOString();
    const freshnessMetric = spec.prometheus?.freshness_metric;
    if (freshnessMetric) {
      const ageSec = await prom.dataAgeSec(freshnessMetric);
      if (ageSec != null && Number.isFinite(ageSec) && ageSec >= 0) {
        lastRunAt = new Date(Date.now() - Math.floor(ageSec * 1000)).toISOString();
      }
    } else {
      for (const p of spec.providers) {
        const q = p.queries?.p50;
        if (!q) continue;
        const ageSec = await prom.dataAgeSec(q);
        if (ageSec != null && Number.isFinite(ageSec) && ageSec >= 0) {
          lastRunAt = new Date(Date.now() - Math.floor(ageSec * 1000)).toISOString();
          break;
        }
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
