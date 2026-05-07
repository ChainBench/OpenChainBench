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
import type { Benchmark, ProviderResult } from "@/types/benchmark";
import { Prometheus } from "@/lib/prometheus";
import { SpecSchema, type Spec } from "@/lib/spec-schema";

export type { Spec } from "@/lib/spec-schema";

const SPECS_DIR = path.join(process.cwd(), "benchmarks");

// Cross-request server cache. Without it, each new HTTP request that
// missed the page-level ISR window would re-run every Prom query for
// every spec — concurrent visitors all paying full price. With it, the
// first miss warms the cache and every later request inside `revalidate`
// gets the result instantly. Wrapped in React `cache()` too so duplicate
// calls within a single render tree dedupe.
const loadAllBenchmarksCached = unstable_cache(
  async (): Promise<Benchmark[]> => {
    const specs = await loadSpecs();
    const benchmarks = await Promise.all(specs.map((s) => specToBenchmark(s)));
    return benchmarks.sort((a, b) => a.number.localeCompare(b.number));
  },
  ["all-benchmarks"],
  { revalidate: 60, tags: ["benchmarks"] }
);
export const loadAllBenchmarks = cache(loadAllBenchmarksCached);

/**
 * Cross-request server cache for chain-filtered loads. Each (slug, chain)
 * combo is computed at most once per `revalidate` window across ALL
 * concurrent users, so flipping between BTC/ETH/SOL tabs hits a warm
 * cache instead of triggering 30+ Prom queries on every click.
 */
const loadBenchmarkForChain = unstable_cache(
  async (slug: string, chain: string): Promise<Benchmark | undefined> => {
    const specs = await loadSpecs();
    const spec = specs.find((s) => s.slug === slug);
    if (!spec) return undefined;
    return specToBenchmark(spec, { chain });
  },
  ["bench-chain"], // cache key prefix
  { revalidate: 60, tags: ["benchmarks"] }
);

/**
 * Load a single bench with an optional dimension filter applied to all queries.
 * `chain` injects `chain="<value>"` into every PromQL label selector.
 */
export const loadBenchmark = cache(async function loadBenchmark(
  slug: string,
  options: { chain?: string } = {}
): Promise<Benchmark | undefined> {
  if (!options.chain) {
    const all = await loadAllBenchmarks();
    return all.find((b) => b.slug === slug);
  }
  return loadBenchmarkForChain(slug, options.chain);
});

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

async function specToBenchmark(
  spec: Spec,
  options: { chain?: string } = {}
): Promise<Benchmark> {
  const editorial: Omit<Benchmark, "results" | "extras" | "sampleSize" | "lastRunAt"> = {
    slug: spec.slug,
    number: spec.number,
    title: spec.title,
    seoTitle: spec.seo_title,
    subtitle: spec.subtitle,
    category: spec.category,
    status: spec.status,
    metric: spec.metric,
    unit: spec.unit,
    higherIsBetter: spec.higher_is_better,
    abstract: spec.abstract,
    methodology: spec.methodology,
    findings: spec.findings,
    source: spec.source,
    dimensions: spec.dimensions,
  };

  const filteredSpec = options.chain
    ? applyChainFilterToSpec(spec, options.chain)
    : spec;

  const live = await tryLoadLive(filteredSpec);
  if (live) {
    return { ...editorial, ...live };
  }
  return draftBenchmark(spec, editorial);
}

/** Inject `chain="X"` into every PromQL label selector across the spec's
 * provider queries. Skips selectors that already filter by chain. */
function applyChainFilterToSpec(spec: Spec, chain: string): Spec {
  const inject = (q: string | undefined) => (q ? injectChainFilter(q, chain) : q);
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
          }
        : p.queries,
    })),
  };
}

function injectChainFilter(query: string, chain: string): string {
  return query.replace(/\{([^}]*)\}/g, (_, inside: string) => {
    if (/\bchain\s*=/.test(inside)) return `{${inside}}`;
    const trimmed = inside.trim();
    if (trimmed === "") return `{chain="${chain}"}`;
    return `{${inside.replace(/\s*$/, "")},chain="${chain}"}`;
  });
}

async function tryLoadLive(
  spec: Spec
): Promise<Pick<Benchmark, "results" | "extras" | "sampleSize" | "lastRunAt"> | null> {
  const url = spec.prometheus?.url ?? process.env.PROMETHEUS_URL;
  if (!url) return null;
  const prom = new Prometheus(url);
  const winSec = parseDurationSec(spec.prometheus?.window ?? "24h") ?? 86_400;

  try {
    const liveResults: ProviderResult[] = [];
    const series24h: Record<string, number[]> = {};
    const series7d: Record<string, number[]> = {};
    const seriesByRegion24h: Record<string, Record<string, number[]>> = {};
    const seriesByRegion7d: Record<string, Record<string, number[]>> = {};
    const regions: Record<string, { region: string; p50: number }[]> = {};
    let totalSamples = 0;
    const sevenDaysSec = 7 * 86_400;

    for (const p of spec.providers) {
      const q = p.queries;
      if (!q) return null;

      const [p50, p90, p99, mean, success, sampleSize] = await Promise.all([
        q.p50 ? prom.scalar(q.p50) : Promise.resolve(null),
        q.p90 ? prom.scalar(q.p90) : Promise.resolve(null),
        q.p99 ? prom.scalar(q.p99) : Promise.resolve(null),
        q.mean ? prom.scalar(q.mean) : Promise.resolve(null),
        q.success ? prom.scalar(q.success) : Promise.resolve(null),
        q.sample_size ? prom.scalar(q.sample_size) : Promise.resolve(null),
      ]);

      // If a provider has no data for the current filter (e.g. Jupiter on
      // BNB Chain when Jupiter is Solana-only), skip it instead of failing
      // the whole benchmark. The page still renders with the providers
      // that do have numbers.
      if (p50 == null || p90 == null || p99 == null) continue;

      liveResults.push({
        name: p.name,
        slug: p.slug,
        tag: p.tag,
        ms: { p50, p90, p99, mean: mean ?? p50 },
        successRate: success != null ? (success > 1 ? success : success * 100) : 100,
        sampleSize: sampleSize ?? undefined,
        secondary: p.secondary,
      });

      if (q.series) {
        const [s24, s7] = await Promise.all([
          prom.series(q.series, winSec, 72),
          prom.series(q.series, sevenDaysSec, 84),
        ]);
        if (s24 && s24.length > 0) series24h[p.slug] = s24;
        if (s7 && s7.length > 0) series7d[p.slug] = s7;
      }

      if (q.regions && q.regions.length > 0) {
        const points = await Promise.all(
          q.regions.map(async (r) => {
            const [p50Val, regionSeries24, regionSeries7] = await Promise.all([
              r.p50 ? prom.scalar(r.p50) : Promise.resolve(p50),
              r.series ? prom.series(r.series, winSec, 72) : Promise.resolve(null),
              r.series ? prom.series(r.series, sevenDaysSec, 84) : Promise.resolve(null),
            ]);
            return {
              region: r.region,
              p50: p50Val ?? p50,
              series24: regionSeries24,
              series7: regionSeries7,
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
        }
      }

      if (sampleSize) totalSamples += sampleSize;
    }

    // No live numbers from anyone (every provider was skipped) → draft.
    if (liveResults.length === 0) return null;

    return {
      results: liveResults,
      extras: {
        series24h,
        series7d: Object.keys(series7d).length > 0 ? series7d : undefined,
        seriesByRegion24h:
          Object.keys(seriesByRegion24h).length > 0 ? seriesByRegion24h : undefined,
        seriesByRegion7d:
          Object.keys(seriesByRegion7d).length > 0 ? seriesByRegion7d : undefined,
        regions: regions as Benchmark["extras"]["regions"],
      },
      sampleSize: totalSamples,
      lastRunAt: new Date().toISOString(),
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
    ms: { p50: 0, p90: 0, p99: 0, mean: 0 },
    successRate: 0,
    secondary: p.secondary,
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
