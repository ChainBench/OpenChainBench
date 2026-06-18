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
  MetricPanel,
  ProviderResult,
} from "@/types/benchmark";
import { getPrometheus } from "@/lib/prometheus";
import { SpecSchema, type Spec } from "@/lib/spec-schema";
import { renderBenchmarkText } from "@/lib/bench-template";
import { liveResults as liveProviderResults } from "@/lib/provider-filters";
import {
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  SECONDS_PER_MINUTE,
} from "@/lib/time-constants";
import {
  activeFilterLabels,
  filterSig,
  parseFilterSig,
  type BenchmarkFilters,
} from "@/lib/materialize/filters";
import {
  applyDimensionsToSpec,
  escapePromLabelValue,
  injectLabels,
  parseDurationSec,
} from "@/lib/materialize/prom-queries";
import {
  buildEditorial,
  draftBenchmark,
  draftPlaceholderForSpec,
} from "@/lib/materialize/editorial";
import { tryLoadCellRanks } from "@/lib/materialize/cell-ranks";

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

// Re-exports: spec.ts and other call sites import these from
// "@/lib/materialize/load". Keep the surface stable.
export {
  buildEditorial,
  draftPlaceholderForSpec,
  filterSig,
  injectLabels,
  parseFilterSig,
};
export type { BenchmarkFilters };

export async function loadSpecsUncached(): Promise<Spec[]> {
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

async function tryLoadLive(
  spec: Spec,
  isFiltered = false
): Promise<Pick<Benchmark, "results" | "extras" | "sampleSize" | "lastRunAt" | "metricPanels"> | null> {
  const url = spec.prometheus?.url ?? process.env.PROMETHEUS_URL;
  if (!url) return null;
  const prom = getPrometheus(url);
  const winSec = parseDurationSec(spec.prometheus?.window ?? "24h") ?? SECONDS_PER_DAY;

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
    const sevenDaysSec = 7 * SECONDS_PER_DAY;
    const thirtyDaysSec = 30 * SECONDS_PER_DAY;

    for (const p of spec.providers) {
      const q = p.queries;
      if (!q) return null;

      let [p50, p90, p99] = await Promise.all([
        q.p50 ? prom.scalar(q.p50) : Promise.resolve(null),
        q.p90 ? prom.scalar(q.p90) : Promise.resolve(null),
        q.p99 ? prom.scalar(q.p99) : Promise.resolve(null),
      ]);
      const [mean, success, sampleSize, slotP50, slotP99] = await Promise.all([
        q.mean ? prom.scalar(q.mean) : Promise.resolve(null),
        q.success ? prom.scalar(q.success) : Promise.resolve(null),
        q.sample_size ? prom.scalar(q.sample_size) : Promise.resolve(null),
        q.slot_p50 ? prom.scalar(q.slot_p50) : Promise.resolve(null),
        q.slot_p99 ? prom.scalar(q.slot_p99) : Promise.resolve(null),
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
      if (liveResults.length < quorum) {
        console.warn(
          `bench quorum fail: ${spec.slug} live=${liveResults.length}/${declared} → keeping previous render`,
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
