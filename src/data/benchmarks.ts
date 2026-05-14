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
import type { Benchmark } from "@/types/benchmark";
import { loadAllBenchmarks, loadBenchmark } from "@/lib/spec";

export type {
  Benchmark,
  ProviderResult,
  ResultExtras,
  RegionPoint,
  Series24h,
} from "@/types/benchmark";

export const getBenchmarks = cache(loadAllBenchmarks);

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
 * we don't need Prometheus at build time. */
export async function getBenchmarkSlugs(): Promise<string[]> {
  if (cachedSlugs) return cachedSlugs;
  try {
    const files = (await fs.readdir(SPECS_DIR)).filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml")
    );
    const slugs = await Promise.all(
      files.map(async (f) => {
        const raw = await fs.readFile(path.join(SPECS_DIR, f), "utf8");
        const parsed = yaml.load(raw) as { slug?: string } | null;
        return parsed?.slug;
      })
    );
    cachedSlugs = slugs.filter((s): s is string => Boolean(s));
    return cachedSlugs;
  } catch {
    return [];
  }
}

