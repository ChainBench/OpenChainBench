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

export const getBenchmarks = cache(loadAllBenchmarks);

export async function getBenchmark(
  slug: string,
  options: { chain?: string; region?: string } = {}
): Promise<Benchmark | undefined> {
  return loadBenchmark(slug, options);
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

