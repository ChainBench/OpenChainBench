/**
 * Question-driven landing pages.
 *
 * Each `answers/<slug>.yml` answers one question with live OpenChainBench
 * data: a hook paragraph, a top-N leaderboard from the referenced bench,
 * a methodology block, an explicit limitations section ("what this number
 * does NOT tell you"), and a FAQ. The slug IS the long-tail query.
 *
 * Pattern adapted from `src/lib/alternatives.ts`: thin wrapper over an
 * existing benchmark, the YAML carries the editorial framing and the
 * bench stays the source of truth for the numbers.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { cache } from "react";
import yaml from "js-yaml";
import { z } from "zod";
import { loadBenchmark } from "@/lib/spec";
import {
  REMOVED_ANSWER_SLUGS,
  REMOVED_BENCH_SLUGS,
} from "@/lib/removed-benches";
import type { Benchmark } from "@/types/benchmark";

const ANSWERS_DIR = path.join(process.cwd(), "answers");

const slugSchema = z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/);

// Editorial voice guard, mirrors spec-schema.ts:176. Em-dash (—) and
// en-dash (–) are the classic "AI tells" that hurt brand voice; refuse
// them on any prose field a maintainer can hand-author. Plain hyphen
// stays legal for compound words.
const noAiDashes = (s: string) =>
  !s.includes("—") && !s.includes("–");
const noAiDashesMsg =
  "Avoid em or en dashes; use a comma, semicolon, or period instead";

const FaqSchema = z.object({
  q: z.string().min(1).max(300),
  a: z.string().min(1).max(2000),
});

const AnswerSchema = z.object({
  slug: slugSchema,
  /** The question this page answers. Used verbatim as H1 + meta title. */
  question: z.string().min(10).max(200),
  /** One-paragraph claim. Surfaced above the leaderboard and used as the
   *  hook in social previews. Renders template placeholders against the
   *  referenced bench so live values land here. */
  short_answer: z.string().min(40).max(800),
  /** Slug of the existing benchmark this page reuses. */
  benchmark: slugSchema,
  /** Optional chain filter applied to the benchmark when rendering. */
  chain: z.string().optional(),
  /** Hook paragraph rendered between the answer and the leaderboard. */
  intro: z.string().min(80).max(3000),
  /** Methodology paragraph rendered below the leaderboard. */
  methodology: z.string().min(80).max(2000),
  /** "What this number does NOT tell you" bullets. Anti-spam signal
   *  Google favours: pages that surface their own limitations rank
   *  higher in adversarial topical clusters. */
  limitations: z.array(z.string().min(20).max(500)).min(1).max(8),
  /** Frequently asked questions block. Emitted as FAQPage JSON-LD. */
  faq: z.array(FaqSchema).min(2).max(20),
  /** Slugs of related answers, rendered as internal links at the bottom
   *  of the page. Keeps the cluster crawlable. */
  related: z.array(slugSchema).max(8).optional(),
  /** Optional editorial commentary from the named maintainer, rendered
   *  as a distinct "Editorial context" block above the leaderboard with
   *  a byline. Substantive prose (400+ chars) that reads as an expert
   *  take on the question, not a data restatement. Only shown when the
   *  referenced bench has a defensible leader (dataPending swap
   *  suppresses it, since commentary without a leaderboard is meaningless).
   *  Emitted as QAPage.suggestedAnswer with a Person author. */
  expert_take: z
    .string()
    .min(400)
    .max(1400)
    .refine(noAiDashes, noAiDashesMsg)
    .optional(),
  /** ISO date (YYYY-MM-DD) of the last editorial review of expert_take.
   *  Kept as a bare date rather than a datetime because reviews are a
   *  human-scale event, not a runtime signal. */
  expert_take_reviewed: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Optional SEO override for browser tab + meta title. */
  seo_title: z.string().min(1).optional(),
  /** Optional SEO override for meta description. Falls back to short_answer. */
  seo_description: z.string().min(1).optional(),
  status: z.enum(["live", "draft"]).default("live"),
});

export type Answer = z.infer<typeof AnswerSchema>;
export type AnswerWithBench = Answer & { bench: Benchmark };

export const loadAllAnswers = cache(async (): Promise<Answer[]> => {
  let files: string[] = [];
  try {
    files = (await fs.readdir(ANSWERS_DIR)).filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
    );
  } catch {
    return [];
  }
  const parsed = await Promise.all(
    files.map(async (f) => {
      const raw = await fs.readFile(path.join(ANSWERS_DIR, f), "utf8");
      const result = AnswerSchema.safeParse(yaml.load(raw));
      if (!result.success) {
        console.warn(`[answers] skipping ${f}:`, result.error.message);
        return null;
      }
      return result.data;
    }),
  );
  return parsed
    .filter((a): a is Answer => a !== null && a.status === "live")
    // Prod-only gate: answers built on staging-pipeline benches never
    // reach the prod listing, sitemap or tag clouds. Direct URL hits
    // get a 410 from middleware.
    .filter(
      (a) =>
        process.env.VERCEL_ENV !== "production" ||
        (!REMOVED_ANSWER_SLUGS.has(a.slug) &&
          !REMOVED_BENCH_SLUGS.has(a.benchmark)),
    )
    .sort((a, b) => a.slug.localeCompare(b.slug));
});

export async function loadAnswerSlugs(): Promise<string[]> {
  const all = await loadAllAnswers();
  return all.map((a) => a.slug);
}

export async function loadAnswer(
  slug: string,
): Promise<AnswerWithBench | undefined> {
  const all = await loadAllAnswers();
  const ans = all.find((a) => a.slug === slug);
  if (!ans) return undefined;
  const bench = await loadBenchmark(ans.benchmark, { chain: ans.chain });
  if (!bench) return undefined;
  return { ...ans, bench };
}
