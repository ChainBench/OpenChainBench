/**
 * Alternative landing pages.
 *
 * Each `alternatives/<slug>.yml` is a thin layer on top of an existing
 * benchmark. it reframes the same data as "X alternatives" so we have
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
import { REMOVED_BENCH_SLUGS } from "@/lib/removed-benches";
import type { Benchmark } from "@/types/benchmark";

const ALT_DIR = path.join(process.cwd(), "alternatives");

const slug = z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/);

// Editorial voice guard, mirrors spec-schema.ts:176. Em-dash (—) and
// en-dash (–) are the classic "AI tells" that hurt brand voice; refuse
// them on any prose field a maintainer can hand-author. Plain hyphen
// stays legal for compound words.
const noAiDashes = (s: string) =>
  !s.includes("—") && !s.includes("–");
const noAiDashesMsg =
  "Avoid em or en dashes; use a comma, semicolon, or period instead";

const AlternativeSchema = z.object({
  slug,
  /** Display name of the product the page is alternative-to. */
  target_product: z.string().min(1),
  /** Optional homepage URL of the target product (rendered as a link).
   *  Pin to http(s) so `javascript:` / `data:` / `file:` never reach a
   *  rendered href. React strips them today, but the schema-time refusal
   *  is the right place to enforce this. */
  target_url: z
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "must be http(s)")
    .optional(),
  /** One-line description of the target product. */
  description: z.string().min(1),
  /** Slug of the existing benchmark this page reuses. */
  benchmark: slug,
  /** Optional chain filter applied to the benchmark when rendering. */
  chain: z.string().optional(),
  /** Lead paragraph rendered above the data. */
  intro: z.string().min(40),
  /** Optional editorial positioning paragraph. Substantive prose (400+
   *  chars) that explains where the target product fits in the market,
   *  what problem it solves and how OpenChainBench measures it. Kept
   *  optional so existing YAMLs keep parsing; populated in a follow-up
   *  editorial pass. */
  positioning: z
    .string()
    .min(400)
    .max(2000)
    .refine(noAiDashes, noAiDashesMsg)
    .optional(),
  /** Optional SEO override for browser tab + meta title. */
  seo_title: z.string().min(1).optional(),
  /** Optional SEO override for meta description. Falls back to intro. */
  seo_description: z.string().min(1).optional(),
  status: z.enum(["live", "draft"]).default("live"),
});

export type Alternative = z.infer<typeof AlternativeSchema>;
type AlternativeWithBench = Alternative & { bench: Benchmark };

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
    .filter((a): a is Alternative => a !== null && a.status === "live")
    // Prod-only gate: alternatives built on staging-pipeline benches
    // never reach the prod listing, sitemap or tag clouds (the page
    // itself already 404s there because the bench spec is filtered).
    .filter(
      (a) =>
        process.env.VERCEL_ENV !== "production" ||
        !REMOVED_BENCH_SLUGS.has(a.benchmark),
    )
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
