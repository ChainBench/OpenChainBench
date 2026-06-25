import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { loadAllAnswers } from "@/lib/answers";
import { loadBenchmark } from "@/lib/spec";
import { renderTemplate } from "@/lib/bench-template";
import { cleanLeftoverTokens } from "@/lib/answers-template";
import { SITE } from "@/data/site";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/page-metadata";

const DESCRIPTION =
  "Direct answers to crypto infrastructure questions, backed by live OpenChainBench measurements. Methodology and limitations on every page.";

export const metadata: Metadata = pageMetadata({
  path: "/answers",
  title: "Answers, backed by live benchmarks",
  description: DESCRIPTION,
});

export default async function AnswersHubPage() {
  const answers = await loadAllAnswers();

  // Resolve template placeholders ({{best_name}}, {{best_p50}}, ...) on
  // the hub itself, otherwise raw tokens leak into the visible
  // short_answer preview. Each YAML's `short_answer` is authored against
  // its referenced bench, so we load that bench and run renderTemplate
  // before the JSX touches the string.
  //
  // Tokens that renderTemplate can't resolve get a neutral fallback so
  // a draft / awaiting-data bench (every provider's p50 still at 0)
  // never surfaces raw `{{best_name}}` to the SERP. Same pattern as
  // resolveLeftoverPlaceholders on the per-chain bench page.
  const rendered = await Promise.all(
    answers.map(async (a) => {
      const bench = await loadBenchmark(a.benchmark, { chain: a.chain });
      const partial = bench
        ? renderTemplate(a.short_answer, bench)
        : a.short_answer;
      const shortAnswer = cleanLeftoverTokens(partial);
      return { ...a, shortAnswer };
    }),
  );

  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "OpenChainBench answers",
    numberOfItems: answers.length,
    itemListElement: answers.map((a, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: a.question,
      url: `${SITE.url}/answers/${a.slug}`,
    })),
  };

  const breadcrumb = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Answers", item: `${SITE.url}/answers` },
    ]),
  };

  return (
    <article className="mx-auto max-w-[900px] px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(itemList) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />
      <h1 className="display text-3xl sm:text-4xl text-ink leading-[1.05]">
        Answers, backed by live benchmarks.
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        Each page below answers one crypto infrastructure question with a
        direct claim, the live OpenChainBench leaderboard that backs it,
        an explicit methodology, and the limitations of the number. No
        verdict, no marketing.
      </p>

      {answers.length === 0 ? (
        <p className="mt-10 text-sm text-ink-muted">
          No answers published yet. Check back soon.
        </p>
      ) : (
        <section className="mt-12">
          <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
            All answers
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-ink-soft leading-snug">
            {answers.length} questions answered with live OpenChainBench
            data, each with its own methodology and limitations.
          </p>
          <ul className="mt-6 divide-y divide-rule border-y border-rule">
            {rendered.map((a) => (
              <li key={a.slug}>
                <Link
                  href={`/answers/${a.slug}`}
                  className="group flex items-center justify-between gap-4 py-4 hover:bg-surface transition-colors"
                >
                  <span className="min-w-0">
                    <span className="block text-lg text-ink font-semibold">
                      {a.question}
                    </span>
                    <span className="mt-0.5 block text-sm text-ink-muted line-clamp-2">
                      {a.shortAnswer}
                    </span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-sm uppercase tracking-wide text-ink-soft group-hover:text-ink transition-colors">
                    Read
                    <ArrowUpRight size={14} strokeWidth={2} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
