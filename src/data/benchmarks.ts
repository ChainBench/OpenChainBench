/**
 * Benchmark loaders.
 *
 * The actual data is loaded asynchronously from the YAML files in
 * `benchmarks/`. There is no static dataset in this repo.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { cache } from "react";
import { downsample, MINI_CHART_POINTS } from "@/lib/downsample";
import type { Benchmark } from "@/types/benchmark";
import {
  loadAllBenchmarks,
  loadAllBenchmarksSafe,
  loadBenchmark,
} from "@/lib/spec";

export type {
  Benchmark,
  ProviderResult,
  ResultExtras,
  RegionPoint,
  Series24h,
} from "@/types/benchmark";

/**
 * Card-shaped projection used by the hub grid and category pages. The
 * full Benchmark object carries ~30 fields per bench (extras.series7d,
 * series30d, seriesByRegion*, metricPanels, methodology, abstract, faq,
 * findings, perChainExplainer, seoIntro, bestPerChain, worstPerChain,
 * cellRanks, providersPerChain, ...) that the card never reads. Passing
 * the full shape to `<BenchmarkGrid />` (a client component) baked the
 * whole thing into the RSC payload — 3.2 MB of HTML for 37 cards, which
 * is what made `/benchmarks` feel like an 8 s page even though the
 * server TTFB is sub-second.
 *
 * Project once at the page boundary so the wire payload only carries
 * what the card + the grid's search/filter use.
 */
export type BenchmarkCardData = {
  slug: string;
  title: string;
  subtitle: string;
  category: Benchmark["category"];
  status: Benchmark["status"];
  editorialStatus: Benchmark["editorialStatus"];
  unit: Benchmark["unit"];
  higherIsBetter: boolean;
  sampleSize: number;
  lastRunAt: string;
  metric: string;
  results: {
    slug: string;
    name: string;
    availability?: "live" | "unavailable";
    ms: { p50: number };
  }[];
  extras: { series24h: Record<string, number[]> };
};

/** Strip a Benchmark to the fields the hub card actually renders. Keeps
 *  `results` in its original sort order so the card's own sort
 *  (best-leader heuristic) stays correct. */
export function toBenchmarkCardData(b: Benchmark): BenchmarkCardData {
  return {
    slug: b.slug,
    title: b.title,
    subtitle: b.subtitle,
    category: b.category,
    status: b.status,
    editorialStatus: b.editorialStatus,
    unit: b.unit,
    higherIsBetter: b.higherIsBetter,
    sampleSize: b.sampleSize,
    lastRunAt: b.lastRunAt,
    metric: b.metric,
    results: b.results.map((r) => ({
      slug: r.slug,
      name: r.name,
      availability: r.availability,
      ms: { p50: r.ms.p50 },
    })),
    // Downsample at the projection boundary: the card's MiniChart caps
    // rendering at MINI_CHART_POINTS anyway, so shipping the raw 24h
    // series (hundreds of points x providers x benches) only bloated
    // the RSC payload without changing a single drawn pixel.
    extras: {
      series24h: Object.fromEntries(
        Object.entries(b.extras?.series24h ?? {}).map(([slug, values]) => [
          slug,
          downsample(values, MINI_CHART_POINTS),
        ])
      ),
    },
  };
}

/**
 * Strict loader. Throws AllBenchmarksDraftError when every bench has
 * collapsed to draft (Prom blackout, cold start with no KV snapshot).
 * Use this in API endpoints, feeds, and crons that should return 503
 * rather than poison downstream consumers with an all-draft snapshot.
 */
export const getBenchmarks = cache(loadAllBenchmarks);

/**
 * Build-and-render safe loader. Catches the all-draft sentinel and
 * returns the draft-placeholder list so `next build` and hub pages
 * still render. Use this in pages enumerated by generateStaticParams
 * or any UI surface that must always produce HTML.
 */
export const getBenchmarksSafe = cache(loadAllBenchmarksSafe);

export async function getBenchmark(
  slug: string,
  options: { chain?: string; region?: string } = {}
): Promise<Benchmark | undefined> {
  return loadBenchmark(slug, options);
}

export async function getBenchmarksByCategory(): Promise<
  Array<[Benchmark["category"], Benchmark[]]>
> {
  const all = await getBenchmarks();
  const map = new Map<Benchmark["category"], Benchmark[]>();
  for (const b of all) {
    const list = map.get(b.category) ?? [];
    list.push(b);
    map.set(b.category, list);
  }
  return Array.from(map.entries());
}

const SPECS_DIR = path.join(process.cwd(), "benchmarks");
let cachedSlugs: string[] | null = null;

/** Slug list for `generateStaticParams`. read directly from filenames so
 * we don't need Prometheus at build time.
 *
 * Filters editorial drafts (spec.status === "draft" in the YAML) so the
 * sitemap, `generateStaticParams` and any other build-time enumeration
 * never advertise unreleased benchmarks. Specs without an explicit
 * `status:` field default to "live" per the Zod schema. */
export async function getBenchmarkSlugs(): Promise<string[]> {
  if (cachedSlugs) return cachedSlugs;
  try {
    const files = (await fs.readdir(SPECS_DIR)).filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml")
    );
    const slugs = await Promise.all(
      files.map(async (f) => {
        const raw = await fs.readFile(path.join(SPECS_DIR, f), "utf8");
        const parsed = yaml.load(raw) as { slug?: string; status?: string } | null;
        if (!parsed?.slug) return null;
        if (parsed.status && parsed.status !== "live") return null;
        return parsed.slug;
      })
    );
    cachedSlugs = slugs.filter((s): s is string => Boolean(s));
    return cachedSlugs;
  } catch {
    return [];
  }
}

