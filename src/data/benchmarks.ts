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
import { leader } from "@/lib/citation";
import { valueQualifier } from "@/lib/value-window";
import { downsample, MINI_CHART_MAX_LINES, MINI_CHART_POINTS } from "@/lib/downsample";
import type { Benchmark, BenchIndexEntry } from "@/types/benchmark";
import { loadBenchIndexFromBlob } from "@/lib/bench-blob";
import { isDevOnlyBench } from "@/lib/removed-benches";
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
  /** Slug of the citation-eligible leader for this bench (result of
   *  `leader(b)` in citation.ts). Passed at the projection boundary so
   *  the hub card can render the same headline the bench page names
   *  without duplicating the reliability + insufficient-sample filter
   *  logic. Null when the bench has no defensible leader (draft,
   *  insufficient, or every provider below the reliability floor with
   *  an empty live pool). */
  leaderSlug: string | null;
  /** Display name of that leader, so the card can say whose number it is
   *  showing. The card rendered `leader.ms.p50` under the label "Field
   *  composite · P50" on all 200 tiles: on bridge-quote-latency that printed
   *  Mobula's 47 ms as the field's median while the field's real median, from
   *  the eight rows the bench page serves, is 315 ms. An engine quoting the
   *  catalogue overstated the field by 6.6 times. */
  leaderName: string | null;
  /** How to describe the headline number, from valueQualifier: "p50, 24h",
   *  "latest value", "7d avg". Never assumed. */
  qualifier: string;
  /** The bench's own window, for the chip and the sample-count footer. The
   *  card hard-coded "24H" and "samples in the last 24 hours", which was
   *  wrong on every 7d bench: bridge-execution-latency reads 1.44 s over 7
   *  days and 89 samples, and the sr-only text, the copy written for
   *  machines, said 24 hours. */
  win: string;
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
  // Same order as MiniChart, best first; a slug without a usable series
  // is skipped there, so over-keep by ranking every result that has one.
  const withSeries = b.results
    .filter((r) => (b.extras?.series24h?.[r.slug]?.length ?? 0) > 1)
    .sort(b.higherIsBetter ? (x, y) => y.ms.p50 - x.ms.p50 : (x, y) => x.ms.p50 - y.ms.p50);
  const drawnSlugs = new Set(withSeries.slice(0, MINI_CHART_MAX_LINES).map((r) => r.slug));
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
    leaderSlug: leader(b)?.slug ?? null,
    leaderName: leader(b)?.name ?? null,
    qualifier: valueQualifier(b),
    win: b.chart?.windowLabel ?? b.window ?? "24h",
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
    // Only the series the card draws: its MiniChart keeps the
    // MINI_CHART_MAX_LINES best by p50, so the rest never reach a pixel.
    extras: {
      series24h: Object.fromEntries(
        Object.entries(b.extras?.series24h ?? {})
          .filter(([slug]) => drawnSlugs.has(slug))
          .map(([slug, values]) => [slug, downsample(values, MINI_CHART_POINTS)])
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

/** Projects a full bench onto its index row. Shared by the worker (which
 *  publishes index.json) and the in-site fallback so both agree. */
export function toBenchIndexEntry(b: Benchmark): BenchIndexEntry {
  return {
    slug: b.slug,
    number: b.number,
    title: b.title,
    subtitle: b.subtitle,
    category: b.category,
    metric: b.metric,
    unit: b.unit,
    status: b.status,
    higherIsBetter: b.higherIsBetter,
    lastRunAt: b.lastRunAt,
  };
}

/**
 * Light index of every bench for navigation surfaces (related benches,
 * category rails). Reads the ~100 KB index.json blob when the worker
 * has published it; otherwise projects the full aggregate, which is
 * what every caller used to load anyway. Never throws.
 */
export const getBenchIndexSafe = cache(async (): Promise<BenchIndexEntry[]> => {
  // The worker publishes from dev, so the blob lists benches production
  // does not serve; a navigation surface built from it links to a 404.
  // The related rail on /benchmarks/wallet-cost did exactly that with bench
  // 310 (SEO audit 2026-10-30). Gate here so every caller inherits it.
  const fromBlob = await loadBenchIndexFromBlob().catch(() => null);
  const rows =
    fromBlob && fromBlob.length >= 40 ? fromBlob : (await loadAllBenchmarksSafe()).map(toBenchIndexEntry);
  return rows.filter((b) => !isDevOnlyBench(b.slug));
});

export async function getBenchmark(
  slug: string,
  options: { chain?: string; region?: string; kind?: string; venue?: string; bucket?: string; tier?: string } = {}
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

