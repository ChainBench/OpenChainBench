import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { loadAnswer, loadAllAnswers } from "@/lib/answers";
import { renderTemplate } from "@/lib/bench-template";
import { cleanLeftoverTokens } from "@/lib/answers-template";
import { Breadcrumb } from "@/components/breadcrumb";
import { Pill } from "@/components/pill";
import { ProviderLogo } from "@/components/provider-logo";
import { fmtValue, fmtUnit, unitSuffix } from "@/lib/format";
import { isRegion } from "@/lib/brand";
import { SITE } from "@/data/site";
import {
  buildBreadcrumbJsonLd,
  buildFaqPageJsonLd,
  safeJsonLd,
} from "@/lib/jsonld";
import { capDescription } from "@/lib/seo-text";
import { getBenchCreatedAt } from "@/lib/seo/bench-dates";

export const revalidate = 60;
export const maxDuration = 300;

type Params = { slug: string };

// On-demand: same reasoning as /alternatives/[slug] and /products/[slug],
// the full multi-bench Prom load at build is too expensive for a small
// editorial scaffold. ISR + the bench unstable_cache keep hot pages
// warm; cold first-hits warm up the CDN.
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const ans = await loadAnswer(slug);
  if (!ans) return {};
  const url = `${SITE.url}/answers/${ans.slug}`;
  const title = ans.seo_title ?? ans.question;
  const descSource = ans.seo_description ?? ans.short_answer;
  // Clean leftover tokens AFTER renderTemplate so a draft bench
  // (e.g. solana-tx-landing-latency mid-soak) never leaks a literal
  // `{{best_name}}` into the meta description, og:description or
  // twitter:description, all of which feed the SERP and social previews.
  const description = capDescription(
    cleanLeftoverTokens(renderTemplate(descSource, ans.bench)),
    158,
  );
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      type: "article",
      url,
      siteName: SITE.name,
    },
    twitter: {
      card: "summary_large_image",
      site: SITE.twitter,
      title,
      description,
    },
  };
}

export default async function AnswerPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const ans = await loadAnswer(slug);
  if (!ans) notFound();

  const { bench } = ans;
  const url = `${SITE.url}/answers/${ans.slug}`;
  const benchUrl = `${SITE.url}/benchmarks/${bench.slug}`;

  // Render template placeholders against the live bench so the answer
  // surfaces real numbers, not raw `{{best_name}}` tokens. Tokens that
  // renderTemplate can't resolve (draft bench, no live data, typo in a
  // YAML's slug reference) fall through to a neutral fallback via
  // cleanLeftoverTokens so a placeholder string never reaches the SERP.
  const render = (s: string) => cleanLeftoverTokens(renderTemplate(s, bench));
  const shortAnswer = render(ans.short_answer);
  const intro = render(ans.intro);
  const methodology = render(ans.methodology);
  const limitations = ans.limitations.map(render);
  const faq = ans.faq.map((f) => ({ q: render(f.q), a: render(f.a) }));

  // Top results from the referenced bench, mirroring the alternatives
  // top-N section: surfaces the answer visually for skim readers + gives
  // crawlers concrete provider names + numbers in the SSR HTML.
  const sortedResults = [...bench.results]
    .filter((r) => !isRegion(r.slug))
    .filter((r) => r.ms.p50 > 0 || r.ms.p99 > 0)
    .sort((a, b) =>
      bench.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
    );
  const topResults = sortedResults.slice(0, 5);

  const allAnswers = await loadAllAnswers();
  const relatedAnswers = (ans.related ?? [])
    .map((rs) => allAnswers.find((a) => a.slug === rs))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));

  // Article + Dataset reference + Breadcrumb. FAQPage emitted as its own
  // standalone script per buildFaqPageJsonLd, which has a markedly higher
  // hit rate in Search Console vs an @graph-nested FAQPage.
  const graphLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": `${url}#article`,
        headline: ans.question,
        description: capDescription(shortAnswer, 990),
        url,
        mainEntityOfPage: url,
        articleBody: `${shortAnswer}\n\n${intro}\n\n${methodology}`,
        datePublished: getBenchCreatedAt(bench.slug).toISOString(),
        dateModified: bench.lastRunAt,
        author: { "@id": `${SITE.url}/#org` },
        publisher: { "@id": `${SITE.url}/#org` },
        isBasedOn: benchUrl,
      },
      buildBreadcrumbJsonLd([
        { name: "Home", item: SITE.url },
        { name: "Answers", item: `${SITE.url}/answers` },
        { name: ans.question, item: url },
      ]),
    ],
  };
  const faqLd = buildFaqPageJsonLd(faq, url);

  return (
    <article className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(graphLd) }}
      />
      {faqLd && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(faqLd) }}
        />
      )}

      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: "Answers", href: "/answers" },
          { label: ans.question },
        ]}
      />

      <Link
        href="/answers"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        All answers
      </Link>

      <div className="mt-6 flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
        <Pill variant="category">Answer</Pill>
        <span className="sm:ml-auto font-sans tabular text-[11px] text-ink-muted">
          Backed by {bench.title}
        </span>
      </div>

      <h1 className="mt-5 display text-2xl sm:text-3xl md:text-4xl tracking-tight leading-tight">
        {ans.question}
      </h1>

      <div className="mt-6 max-w-3xl border-y border-rule py-5 text-base sm:text-lg leading-relaxed text-ink">
        {shortAnswer}
      </div>

      <p className="mt-6 max-w-3xl text-base leading-relaxed text-ink-soft">
        {intro}
      </p>

      {topResults.length > 0 && (
        <section className="mt-12">
          <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-ink-faint">
            Live leaderboard, top {topResults.length}
          </h2>
          <ol className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {topResults.map((r, i) => (
              <li key={r.slug}>
                <Link
                  href={`/products/${r.slug}`}
                  className="card-soft rounded-xl p-4 flex flex-col gap-2 h-full hover:border-ink/40 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <ProviderLogo slug={r.slug} name={r.name} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink leading-tight truncate">
                        {r.name}
                      </p>
                      <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint font-medium">
                        #{i + 1} · {bench.metric}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-ink">
                    <span className="font-sans tabular text-lg font-semibold">
                      {fmtValue(r.ms.p50, bench.unit)}
                    </span>
                    <span className="font-sans text-[11px] text-ink-muted">
                      {unitSuffix(bench.unit, r.ms.p50).trim()}
                    </span>
                    <span className="w-full sm:w-auto sm:ml-auto text-[11px] text-ink-faint">
                      p99 {fmtUnit(r.ms.p99, bench.unit)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-ink-muted">
            Full live data:{" "}
            <Link className="lnk" href={`/benchmarks/${bench.slug}`}>
              /benchmarks/{bench.slug}
            </Link>
            , refreshed every minute.
          </p>
        </section>
      )}

      <section className="mt-12">
        <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
          Methodology and data sources
        </h2>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-ink-soft">
          {methodology}
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
          What this number does not tell you
        </h2>
        <ul className="mt-3 space-y-3 text-base leading-relaxed text-ink-soft">
          {limitations.map((l) => (
            <li key={l} className="flex gap-3">
              <span className="text-ink-faint">·</span>
              <span>{l}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
          Frequently asked questions
        </h2>
        <dl className="mt-4 space-y-6">
          {faq.map((item) => (
            <div key={item.q}>
              <dt className="text-base font-semibold text-ink">{item.q}</dt>
              <dd className="mt-2 text-base leading-relaxed text-ink-soft">
                {item.a}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {relatedAnswers.length > 0 && (
        <section className="mt-12">
          <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
            Related questions
          </h2>
          <ul className="mt-4 divide-y divide-rule border-y border-rule">
            {relatedAnswers.map((r) => (
              <li key={r.slug}>
                <Link
                  href={`/answers/${r.slug}`}
                  className="group flex items-center justify-between gap-4 py-3 hover:bg-surface transition-colors"
                >
                  <span className="text-base text-ink-soft group-hover:text-ink">
                    {r.question}
                  </span>
                  <ArrowUpRight
                    size={14}
                    strokeWidth={2}
                    className="text-ink-faint group-hover:text-ink shrink-0"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-12 max-w-2xl text-xs text-ink-muted">
        Same data as{" "}
        <Link href={`/benchmarks/${bench.slug}`} className="lnk text-ink-soft">
          /benchmarks/{bench.slug}
        </Link>
        {ans.chain ? ` (filtered to ${ans.chain})` : ""}, refreshed every
        minute. Open methodology, open source.
      </p>
    </article>
  );
}
