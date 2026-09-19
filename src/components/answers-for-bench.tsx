/**
 * "Questions this benchmark answers": the answer pages built on this
 * bench, linked from the bench page. Before this, no page outside
 * /answers itself linked an answer (audit 2026-09-19, major 1): 37 answer
 * pages, 2,056 impressions, 5 clicks, fed only by their own index while
 * the bench pages they cite rank on page one. loadAllAnswers already
 * drops answers whose bench is absent from this deployment and, on prod,
 * the removed slugs, so every link here resolves.
 */
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { loadAllAnswers } from "@/lib/answers";

export async function AnswersForBench({
  benchSlug,
  benchSlugs,
  heading = "Questions this benchmark answers",
}: {
  benchSlug?: string;
  benchSlugs?: string[];
  heading?: string;
}) {
  const wanted = new Set(benchSlugs ?? (benchSlug ? [benchSlug] : []));
  const answers = (await loadAllAnswers()).filter((a) => wanted.has(a.benchmark));
  if (answers.length === 0) return null;
  return (
    <nav className="mt-10 max-w-3xl" aria-labelledby="bench-answers">
      <h2 id="bench-answers" className="label-mono text-ink-muted">
        {heading}
      </h2>
      <ul className="mt-3 space-y-1.5">
        {answers.map((a) => (
          <li key={a.slug}>
            <Link
              href={`/answers/${a.slug}`}
              className="lnk inline-flex items-baseline gap-1 text-sm"
            >
              {a.question}
              <ArrowUpRight className="h-3 w-3 shrink-0 self-center" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
