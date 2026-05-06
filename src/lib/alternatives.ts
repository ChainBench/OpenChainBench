/**
 * Alternative landing pages.
 *
 * Each `alternatives/<slug>.yml` is a thin layer on top of an existing
 * benchmark — it reframes the same data as "X alternatives" so we have
 * a public URL to drop in Discord/Twitter when someone asks for a
 * competitor. The benchmark stays the source of truth; the alternative
 * file only carries the framing copy and a pointer to its bench.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { cache } from "react";
import yaml from "js-yaml";
import { z } from "zod";
import { loadBenchmark } from "@/lib/spec";
import type { Benchmark } from "@/types/benchmark";

const ALT_DIR = path.join(process.cwd(), "alternatives");

const slug = z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/);

const AlternativeSchema = z.object({
  slug,
  /** Display name of the product the page is alternative-to. */
  target_product: z.string().min(1),
  /** Optional homepage URL of the target product (rendered as a link). */
  target_url: z.url().optional(),
  /** One-line description of the target product. */
  description: z.string().min(1),
  /** Slug of the existing benchmark this page reuses. */
  benchmark: slug,
  /** Optional chain filter applied to the benchmark when rendering. */
  chain: z.string().optional(),
  /** Lead paragraph rendered above the data. */
  intro: z.string().min(40),
  /** Optional SEO override for browser tab + meta title. */
  seo_title: z.string().min(1).optional(),
  /** Optional SEO override for meta description. Falls back to intro. */
  seo_description: z.string().min(1).optional(),
  status: z.enum(["live", "draft"]).default("live"),
});

export type Alternative = z.infer<typeof AlternativeSchema>;
export type AlternativeWithBench = Alternative & { bench: Benchmark };

export const loadAllAlternatives = cache(async (): Promise<Alternative[]> => {
  let files: string[] = [];
  try {
    files = (await fs.readdir(ALT_DIR)).filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml")
    );
  } catch {
    return [];
  }
  const parsed = await Promise.all(
    files.map(async (f) => {
      const raw = await fs.readFile(path.join(ALT_DIR, f), "utf8");
      const result = AlternativeSchema.safeParse(yaml.load(raw));
      if (!result.success) {
        console.warn(`[alternatives] skipping ${f}:`, result.error.message);
        return null;
      }
      return result.data;
    })
  );
  return parsed
    .filter((a): a is Alternative => a !== null)
    .sort((a, b) => a.target_product.localeCompare(b.target_product));
});

export async function loadAlternativeSlugs(): Promise<string[]> {
  const all = await loadAllAlternatives();
  return all.map((a) => a.slug);
}

export async function loadAlternative(
  slug: string
): Promise<AlternativeWithBench | undefined> {
  const all = await loadAllAlternatives();
  const alt = all.find((a) => a.slug === slug);
  if (!alt) return undefined;
  const bench = await loadBenchmark(alt.benchmark, { chain: alt.chain });
  if (!bench) return undefined;
  return { ...alt, bench };
}
