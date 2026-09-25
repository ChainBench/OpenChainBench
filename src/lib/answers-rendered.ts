/**
 * One rendering of the answer set, shared by every surface that quotes an answer.
 *
 * The hub page resolved `{{best_name}}` / `{{best_p50}}` itself, including the guard that
 * swaps the whole sentence when the referenced bench has no defensible leader (otherwise
 * `cleanLeftoverTokens` writes "The current leader currently leads at measured live"). Every
 * other surface that wants the same sentence, llms.txt, llms-full.txt, /api/citable and the
 * MCP server, would have had to repeat that guard. This module is the one copy of it, so a
 * fix to the pending-data wording reaches the machine-readable surfaces and the page together.
 *
 * `cache` is React's per-request cache, matching `loadAllAnswers`: a route that reads the
 * answers twice renders them once.
 */

import { cache } from "react";
import { loadAllAnswers, type Answer } from "@/lib/answers";
import { loadBenchmark } from "@/lib/spec";
import { renderTemplate } from "@/lib/bench-template";
import {
  benchDataPendingFallback,
  cleanLeftoverTokens,
  hasLiveDataTokens,
} from "@/lib/answers-template";
import { leader } from "@/lib/citation";
import { SITE } from "@/data/site";
import type { Benchmark } from "@/types/benchmark";

export type RenderedAnswer = Answer & {
  /** `short_answer` with its tokens resolved against `bench`, ready to publish. */
  shortAnswer: string;
  /** The referenced bench, or undefined when this deployment cannot load it. */
  bench: Benchmark | undefined;
  /** Canonical URL of the answer page. */
  url: string;
};

export const loadRenderedAnswers = cache(async (): Promise<RenderedAnswer[]> => {
  const answers = await loadAllAnswers();
  const rendered = await Promise.all(answers.map((a) => renderAnswer(a)));
  // Same rule as `loadAnswer`, which the detail page runs: an answer whose bench this
  // deployment cannot load renders a 404 there, so it must not be listed here either. The
  // case is a spec the worker's aggregate has not swept yet; without this filter the four
  // machine-readable surfaces published a dead URL next to the half-filled sentence the
  // pending guard exists to prevent (review 2026-09-24).
  return rendered.filter((a): a is RenderedAnswer & { bench: Benchmark } => a.bench !== undefined);
});

async function renderAnswer(a: Answer): Promise<RenderedAnswer> {
  const bench = await loadBenchmark(a.benchmark, { chain: a.chain });
  const url = `${SITE.url}/answers/${a.slug}`;
  // Same guard as the answer detail page: a bench with no leader plus a sentence that depends
  // on live tokens gets the canned bench-scoped fallback, never a half-filled sentence.
  if (bench && !leader(bench) && hasLiveDataTokens(a.short_answer)) {
    const fallback = benchDataPendingFallback(
      bench.title,
      `${SITE.url}/benchmarks/${bench.slug}`,
    );
    return { ...a, bench, url, shortAnswer: fallback.short_answer };
  }
  const partial = bench ? renderTemplate(a.short_answer, bench) : a.short_answer;
  return { ...a, bench, url, shortAnswer: cleanLeftoverTokens(partial) };
}

/** Single-line form for the text surfaces (llms.txt, llms-full.txt). */
export function answerOneLine(a: RenderedAnswer): string {
  return a.shortAnswer.replace(/\s+/g, " ").trim();
}
