import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { loadAnswer, loadAllAnswers } from "@/lib/answers";
import { renderTemplate } from "@/lib/bench-template";
import {
  cleanLeftoverTokens,
  hasLiveDataTokens,
  benchDataPendingFallback,
} from "@/lib/answers-template";
import { citableAsOf, leader } from "@/lib/citation";
import { Breadcrumb } from "@/components/breadcrumb";
import { Byline } from "@/components/byline";
import { Pill } from "@/components/pill";
import { ProviderLogo } from "@/components/provider-logo";
import { fmtAsOfUtc, fmtValue, fmtUnit, unitSuffix } from "@/lib/format";
import { isRegion } from "@/lib/brand";
import { SITE } from "@/data/site";
import {
  buildBreadcrumbJsonLd,
  buildFaqPageJsonLd,
  safeJsonLd,
} from "@/lib/jsonld";
import { PERSON_ID } from "@/lib/hub-jsonld";
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
  // Clean leftover tokens AFTER renderTemplate so a draft bench never
  // leaks a literal `{{best_name}}` into the meta description,
  // og:description or twitter:description, all of which feed the SERP
  // and social previews. When the referenced bench has no defensible
  // leader AND the source relies on live tokens, swap the meta
  // description for the "data pending" fallback so the SERP snippet
  // does not read as broken grammar.
  const metaTop = leader(ans.bench);
  const metaDescription =
    !metaTop && hasLiveDataTokens(descSource)
      ? benchDataPendingFallback(
          ans.bench.title,
          `${SITE.url}/benchmarks/${ans.bench.slug}`,
        ).short_answer
      : cleanLeftoverTokens(renderTemplate(descSource, ans.bench));
  const description = capDescription(metaDescription, 158);
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
      images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      site: SITE.twitter,
      title,
      description,
      images: [`${SITE.url}/twitter-image`],
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
  // Real measurement timestamp on live benches, null on drafts (whose
  // lastRunAt is a wall-clock placeholder from the loader). Prevents the
  // visible "Data as of ..." line and the associated <time dateTime>
  // structured-data anchor from spoofing freshness for a bench that has
  // never actually been measured.
  const asOfStamp = citableAsOf(bench);
  const asOfUtc = asOfStamp ? fmtAsOfUtc(asOfStamp) : null;
  // Detect the "referenced bench has no defensible leader AND the
  // source YAML depends on live tokens" case: without this guard the
  // per-token fallback rewrites {{best_name}} to "The current leader"
  // and {{best_p50}} to "measured live" inside sentences whose grammar
  // assumes a proper-noun subject, producing broken output like "The
  // current leader currently leads Solana transaction landing latency
  // at measured live (p50, 24h)". When we know both the bench has no
  // leader and the source string depends on live tokens, swap the
  // whole prose surface with a canned "data pending" fallback that
  // reads naturally across every downstream consumer (meta description,
  // JSON-LD Article.description, LLM grounding trace).
  const top = leader(bench);
  const dataPending =
    !top &&
    (hasLiveDataTokens(ans.short_answer) ||
      hasLiveDataTokens(ans.intro) ||
      hasLiveDataTokens(ans.methodology));
  const pending = dataPending
    ? benchDataPendingFallback(bench.title, benchUrl)
    : null;
  const shortAnswer = pending
    ? pending.short_answer
    : render(ans.short_answer);
  const intro = pending ? pending.intro : render(ans.intro);
  const methodology = pending ? pending.methodology : render(ans.methodology);
  const limitations = pending ? [] : ans.limitations.map(render);
  const faq = pending ? [] : ans.faq.map((f) => ({ q: render(f.q), a: render(f.a) }));

  // Top results from the referenced bench, mirroring the alternatives
  // top-N section: surfaces the answer visually for skim readers + gives
  // crawlers concrete provider names + numbers in the SSR HTML.
  const sortedResults = [...bench.results]
    .filter((r) => !isRegion(r.slug))
    .filter((r) => r.ms.p50 !== 0 || r.ms.p99 !== 0)
    .sort((a, b) =>
      bench.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
    );
  const topResults = sortedResults.slice(0, 5);

  const allAnswers = await loadAllAnswers();
  const relatedAnswers = (ans.related ?? [])
    .map((rs) => allAnswers.find((a) => a.slug === rs))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));

  // Rendered expert commentary from the named maintainer. Only surfaced
  // when the referenced bench has a defensible leader (dataPending
  // suppresses it because editorial context without a leaderboard is
  // meaningless). expert_take is a schema-optional field on the answers
  // YAML populated in a follow-up editorial pass.
  const expertTake =
    !dataPending && ans.expert_take ? render(ans.expert_take) : null;

  // QAPage with acceptedAnswer + optional suggestedAnswer. The upgrade
  // from generic Article to QAPage lets Search Console + AI answer
  // surfaces treat the URL as a canonical Q&A rather than a generic
  // article, which is what the answers cluster is actually shaped like.
  //   - acceptedAnswer: the auto-generated short answer, Org-authored.
  //     Data-derived, publishing under institutional attribution.
  //   - suggestedAnswer: the expert_take paragraph, Person-authored.
  //     Editorial commentary, attributed to the named maintainer.
  // FAQPage still ships as a standalone script (higher Search Console
  // hit rate on standalone vs @graph-nested).
  const questionNode: Record<string, unknown> = {
    "@type": "Question",
    "@id": `${url}#question`,
    name: ans.question,
    text: ans.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: capDescription(shortAnswer, 990),
      url,
      author: { "@id": `${SITE.url}/#org` },
    },
  };
  if (expertTake) {
    questionNode.suggestedAnswer = {
      "@type": "Answer",
      text: capDescription(expertTake, 990),
      url,
      author: { "@id": PERSON_ID },
      ...(ans.expert_take_reviewed
        ? { dateModified: ans.expert_take_reviewed }
        : {}),
    };
  }
  const graphLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "QAPage",
        "@id": `${url}#qapage`,
        url,
        mainEntity: questionNode,
        headline: ans.question,
        description: capDescription(shortAnswer, 990),
        datePublished: getBenchCreatedAt(bench.slug).toISOString(),
        ...(citableAsOf(bench)
          ? { dateModified: bench.lastRunAt }
          : {}),
        // Org authors the page as a whole (Q + acceptedAnswer). The
        // Person's contribution surfaces as suggestedAnswer.author on
        // the Question node above so attribution stays per-answer.
        author: { "@id": `${SITE.url}/#org` },
        publisher: { "@id": `${SITE.url}/#org` },
        image: `${SITE.url}/api/og/${bench.slug}`,
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
        {/* Dated freshness stamp right next to the quotable sentence,
            mirroring the "Data as of ... UTC" line on the bench pages.
            Answer engines quote a claim far more readily when the date
            of measurement sits beside it. Uses the referenced bench's
            lastRunAt (real data timestamp), not build time. */}
        {asOfUtc && asOfStamp && (
          <p className="mt-3 text-[11px] text-ink-faint">
            Data as of <time dateTime={asOfStamp}>{asOfUtc}</time>,
            refreshed continuously.
          </p>
        )}
      </div>

      <p className="mt-6 max-w-3xl text-base leading-relaxed text-ink-soft">
        {intro}
      </p>

      {expertTake && (
        <section className="mt-10 max-w-3xl rounded-lg border border-ink/10 bg-paper-soft/40 px-5 py-5">
          <h2 className="font-sans text-[11px] uppercase tracking-[0.16em] text-ink-muted font-medium">
            Editorial context
          </h2>
          <p className="mt-3 text-base leading-relaxed text-ink-soft">
            {expertTake}
          </p>
          <Byline reviewed={ans.expert_take_reviewed} />
        </section>
      )}

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

      {/* Limitations and FAQ are omitted entirely on the pending-data
          variant: the arrays are empty in that case (see the pending
          swap above), and rendering an <h2> with no items below reads
          as UI dead space to a human and as broken structured data to a
          crawler. When the bench has live data both sections render
          normally. */}
      {limitations.length > 0 && (
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
      )}

      {faq.length > 0 && (
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
      )}

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
