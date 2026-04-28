/**
 * Benchmark specs.
 *
 * Each `benchmarks/*.yml` file is a self-contained submission: editorial
 * metadata + Prometheus queries. Drop a new file in the directory and open
 * a PR — the build picks it up.
 *
 * The loader queries Prometheus at build time / on ISR revalidation. If
 * Prometheus is unreachable or returns no usable rows, the benchmark falls
 * back to the matching mock entry in `src/data/benchmarks.ts` so the page
 * always renders.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { cache } from "react";
import yaml from "js-yaml";
import type { Benchmark, ProviderResult } from "@/data/benchmarks";
import { Prometheus } from "@/lib/prometheus";

export type Spec = {
  slug: string;
  prometheus?: {
    url?: string;
    window?: string;
  };
  providers: SpecProvider[];
};

export type SpecProvider = {
  slug: string;
  queries?: {
    p50?: string;
    p90?: string;
    p99?: string;
    mean?: string;
    success?: string;
    sample_size?: string;
    series?: string;
    regions?: { region: string; p50?: string }[];
  };
};

const SPECS_DIR = path.join(process.cwd(), "benchmarks");

export const loadSpecs = cache(async (): Promise<Spec[]> => {
  let files: string[] = [];
  try {
    files = (await fs.readdir(SPECS_DIR)).filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml")
    );
  } catch {
    return [];
  }
  return Promise.all(
    files.map(async (f) => {
      const raw = await fs.readFile(path.join(SPECS_DIR, f), "utf8");
      return yaml.load(raw) as Spec;
    })
  );
});

/**
 * Overlay live Prometheus numbers onto a fallback benchmark. Returns the
 * fallback unchanged if the spec is missing, the URL is unset, or any
 * required percentile query fails.
 */
export async function overlayLive(fallback: Benchmark): Promise<Benchmark> {
  const specs = await loadSpecs();
  const spec = specs.find((s) => s.slug === fallback.slug);
  if (!spec) return fallback;
  const url = spec.prometheus?.url ?? process.env.PROMETHEUS_URL;
  if (!url) return fallback;

  const prom = new Prometheus(url);
  const winSec = parseDurationSec(spec.prometheus?.window ?? "24h") ?? 86_400;

  try {
    const liveResults: ProviderResult[] = [];
    const series24h: Record<string, number[]> = { ...fallback.extras.series24h };
    const regions: Record<string, { region: string; p50: number }[]> = {
      ...fallback.extras.regions,
    };
    let totalSamples = 0;

    for (const fr of fallback.results) {
      const sp = spec.providers.find((p) => p.slug === fr.slug);
      const q = sp?.queries;
      if (!q) {
        liveResults.push(fr);
        continue;
      }
      const [p50, p90, p99, mean, success, sampleSize] = await Promise.all([
        q.p50 ? prom.scalar(q.p50) : Promise.resolve(null),
        q.p90 ? prom.scalar(q.p90) : Promise.resolve(null),
        q.p99 ? prom.scalar(q.p99) : Promise.resolve(null),
        q.mean ? prom.scalar(q.mean) : Promise.resolve(null),
        q.success ? prom.scalar(q.success) : Promise.resolve(null),
        q.sample_size ? prom.scalar(q.sample_size) : Promise.resolve(null),
      ]);

      if (p50 == null || p90 == null || p99 == null) {
        // Couldn't get a full percentile triplet — bail to fallback.
        return fallback;
      }

      liveResults.push({
        ...fr,
        ms: { p50, p90, p99, mean: mean ?? p50 },
        successRate:
          success != null ? (success > 1 ? success : success * 100) : fr.successRate,
      });

      if (q.series) {
        const s = await prom.series(q.series, winSec, 24);
        if (s && s.length > 0) series24h[fr.slug] = s;
      }

      if (q.regions && q.regions.length > 0) {
        const points = await Promise.all(
          q.regions.map(async (r) => ({
            region: r.region,
            p50: r.p50 ? (await prom.scalar(r.p50)) ?? p50 : p50,
          }))
        );
        regions[fr.slug] =
          points as Benchmark["extras"]["regions"][string];
      }

      if (sampleSize) totalSamples += sampleSize;
    }

    return {
      ...fallback,
      lastRunAt: new Date().toISOString(),
      sampleSize: totalSamples > 0 ? totalSamples : fallback.sampleSize,
      results: liveResults,
      extras: { series24h, regions: regions as Benchmark["extras"]["regions"] },
    };
  } catch {
    return fallback;
  }
}

function parseDurationSec(d: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(d.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  return n * { s: 1, m: 60, h: 3600, d: 86_400 }[unit as "s" | "m" | "h" | "d"];
}
