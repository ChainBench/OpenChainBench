/**
 * Spec loader.
 *
 * Reads every YAML file in `benchmarks/`, validates it against the schema,
 * queries Prometheus for live numbers, and returns a `Benchmark[]` ready
 * for rendering. There are no fallback mocks — if Prometheus has nothing,
 * the benchmark renders in a "draft" state (page shows the editorial
 * metadata, but the results section is replaced by a "Awaiting first run"
 * notice).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { cache } from "react";
import yaml from "js-yaml";
import type { Benchmark, ProviderResult } from "@/types/benchmark";
import { Prometheus } from "@/lib/prometheus";
import { SpecSchema, type Spec } from "@/lib/spec-schema";

export type { Spec } from "@/lib/spec-schema";

const SPECS_DIR = path.join(process.cwd(), "benchmarks");

export const loadAllBenchmarks = cache(async (): Promise<Benchmark[]> => {
  const specs = await loadSpecs();
  const benchmarks = await Promise.all(specs.map(specToBenchmark));
  return benchmarks.sort((a, b) => a.number.localeCompare(b.number));
});

export async function loadBenchmark(slug: string): Promise<Benchmark | undefined> {
  const all = await loadAllBenchmarks();
  return all.find((b) => b.slug === slug);
}

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

async function specToBenchmark(spec: Spec): Promise<Benchmark> {
  const editorial: Omit<Benchmark, "results" | "extras" | "sampleSize" | "lastRunAt"> = {
    slug: spec.slug,
    number: spec.number,
    title: spec.title,
    subtitle: spec.subtitle,
    category: spec.category,
    status: spec.status,
    metric: spec.metric,
    unit: spec.unit,
    abstract: spec.abstract,
    methodology: spec.methodology,
    findings: spec.findings,
    source: spec.source,
  };

  const live = await tryLoadLive(spec);
  if (live) {
    return { ...editorial, ...live };
  }
  return draftBenchmark(spec, editorial);
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
    const regions: Record<string, { region: string; p50: number }[]> = {};
    let totalSamples = 0;

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

      if (p50 == null || p90 == null || p99 == null) return null;

      liveResults.push({
        name: p.name,
        slug: p.slug,
        tag: p.tag,
        ms: { p50, p90, p99, mean: mean ?? p50 },
        successRate: success != null ? (success > 1 ? success : success * 100) : 100,
        secondary: p.secondary,
      });

      if (q.series) {
        const s = await prom.series(q.series, winSec, 24);
        if (s && s.length > 0) series24h[p.slug] = s;
      }

      if (q.regions && q.regions.length > 0) {
        const points = await Promise.all(
          q.regions.map(async (r) => ({
            region: r.region,
            p50: r.p50 ? (await prom.scalar(r.p50)) ?? p50 : p50,
          }))
        );
        regions[p.slug] = points;
      }

      if (sampleSize) totalSamples += sampleSize;
    }

    return {
      results: liveResults,
      extras: { series24h, regions: regions as Benchmark["extras"]["regions"] },
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
  // Render the page even when Prometheus has no data yet — the editorial
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
