import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { getBenchmark, getBenchmarks } from "@/data/benchmarks";
import { liveResults } from "@/lib/provider-filters";
import { fmtUnit } from "@/lib/format";
import { capDescription } from "@/lib/seo-text";
import { SITE } from "@/data/site";
import { safeJsonLd } from "@/lib/jsonld";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import type { Benchmark, ProviderResult } from "@/types/benchmark";

// Dedicated per-chain landing pages. Only chains that have a hand-written
// `per_chain_explainer` entry in the bench YAML get a route here - that
// unique editorial body is what keeps these pages from being doorway
// duplicates of the parent bench. The parent's `?chain=` query filter
// stays a client-side UI affordance; THIS route is the indexable,
// self-canonical document targeting long-tail queries like "ethereum
// finality time".
export const revalidate = 60;

type Params = { slug: string; chain: string };

export async function generateStaticParams() {
  const benchmarks = await getBenchmarks();
  return benchmarks.flatMap((b) => {
    const resultSlugs = new Set(b.results.map((r) => r.slug));
    return (b.perChainExplainer ?? [])
      .filter((e) => resultSlugs.has(e.slug))
      .map((e) => ({ slug: b.slug, chain: e.slug }));
  });
}

type ChainPageData = {
  benchmark: Benchmark;
  explainer: { slug: string; h2: string; body: string };
  result: ProviderResult;
  sorted: ProviderResult[];
  rank: number;
};

async function loadChainPage(
  slug: string,
  chain: string,
): Promise<ChainPageData | null> {
  const benchmark = await getBenchmark(slug);
  if (!benchmark) return null;
  const explainer = (benchmark.perChainExplainer ?? []).find(
    (e) => e.slug === chain,
  );
  if (!explainer) return null;
  const result = benchmark.results.find((r) => r.slug === chain);
  if (!result) return null;
  const live = liveResults(benchmark.results);
  const sorted = [...live].sort((a, b) =>
    benchmark.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
  );
  const rank = sorted.findIndex((r) => r.slug === chain) + 1;
  return { benchmark, explainer, result, sorted, rank };
}

/** Meta descriptions must not leak inline markdown from the YAML body
 *  (backticks around RPC method names, bold, links). */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function asOfDate(lastRunAt: string | undefined): string {
  const d = lastRunAt ? new Date(lastRunAt) : new Date();
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug, chain } = await params;
  const data = await loadChainPage(slug, chain);
  if (!data) return {};
  const { benchmark, explainer, result } = data;
  const value = fmtUnit(result.ms.p50, benchmark.unit);
  const title = `${explainer.h2}: ${value} p50 live`;
  const description = capDescription(
    stripInlineMarkdown(explainer.body),
    158,
  );
  const canonical = `${SITE.url}/benchmarks/${benchmark.slug}/${chain}`;
  const ogImage = `${SITE.url}/api/og/${benchmark.slug}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      type: "article",
      url: canonical,
      images: [ogImage],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  };
}

export default async function BenchmarkChainPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug, chain } = await params;
  const data = await loadChainPage(slug, chain);
  if (!data) notFound();
  const { benchmark, explainer, result, sorted, rank } = data;

  const benchmarkUrl = `${SITE.url}/benchmarks/${benchmark.slug}`;
  const pageUrl = `${benchmarkUrl}/${chain}`;
  const catColor = CATEGORY_COLOR[benchmark.category];
  const p50 = fmtUnit(result.ms.p50, benchmark.unit);
  const p90 = fmtUnit(result.ms.p90, benchmark.unit);
  const p99 = fmtUnit(result.ms.p99, benchmark.unit);
  const explainerSlugs = new Set(
    (benchmark.perChainExplainer ?? []).map((e) => e.slug),
  );

  // Dated, citable key-facts sentence. LLM crawlers and journalists quote
  // stats that carry an explicit date + source; featured snippets prefer
  // the same shape.
  const keyFacts =
    `As of ${asOfDate(benchmark.lastRunAt)}, ${explainer.h2.toLowerCase()} is ${p50} at the median (p50, 24h window), with ${p90} at p90 and ${p99} at p99.` +
    (rank > 0
      ? ` ${result.name} ranks #${rank} of ${sorted.length} chains measured on this benchmark.`
      : "");

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        "@id": `${pageUrl}#article`,
        headline: explainer.h2,
        description: capDescription(stripInlineMarkdown(explainer.body), 158),
        url: pageUrl,
        mainEntityOfPage: pageUrl,
        articleBody: `${keyFacts} ${stripInlineMarkdown(explainer.body)}`,
        image: `${SITE.url}/api/og/${benchmark.slug}`,
        dateModified: benchmark.lastRunAt,
        author: { "@id": `${SITE.url}/#org` },
        publisher: { "@id": `${SITE.url}/#org` },
        about: { "@id": `${benchmarkUrl}#dataset` },
        isPartOf: { "@id": `${benchmarkUrl}#article` },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE.url },
          {
            "@type": "ListItem",
            position: 2,
            name: "Benchmarks",
            item: `${SITE.url}/benchmarks`,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: benchmark.title,
            item: benchmarkUrl,
          },
          {
            "@type": "ListItem",
            position: 4,
            name: result.name,
            item: pageUrl,
          },
        ],
      },
    ],
  };

  return (
    <article className="mx-auto max-w-5xl w-full px-4 sm:px-6 pt-10 sm:pt-14 overflow-x-clip min-w-0">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />

      <nav
        aria-label="Breadcrumb"
        className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] sm:tracking-[0.16em] text-ink-faint"
      >
        <ol className="flex flex-wrap items-center gap-1 sm:gap-1.5 min-w-0">
          <li>
            <Link href="/" className="hover:text-ink transition-colors">
              Home
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li>
            <Link href="/benchmarks" className="hover:text-ink transition-colors">
              Benchmarks
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li>
            <Link
              href={`/benchmarks/${benchmark.slug}`}
              className="hover:text-ink transition-colors"
            >
              {benchmark.title}
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li className="text-ink-muted truncate max-w-[40vw] sm:max-w-none">
            {result.name}
          </li>
        </ol>
      </nav>

      <Link
        href={`/benchmarks/${benchmark.slug}`}
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        Full benchmark: {benchmark.title}
      </Link>

      <div className="mt-6 flex flex-wrap items-center gap-3 font-sans text-[11px] uppercase tracking-[0.1em] sm:tracking-[0.18em] text-ink-muted font-medium">
        <span style={{ color: catColor ?? "var(--color-ink-soft)" }}>
          {benchmark.category}
        </span>
        <span className="text-ink-faint">{result.name}</span>
      </div>

      <h1 className="mt-5 display text-3xl sm:text-4xl md:text-5xl tracking-tight text-ink break-words">
        {explainer.h2}
      </h1>

      {/* Dated key-facts line. Server-rendered first so the citable,
          date-stamped stat lands in the first ~100 words of the document. */}
      <p className="mt-4 max-w-3xl text-lg sm:text-xl text-ink-muted leading-snug break-words">
        {keyFacts}
      </p>

      <div className="mt-6 max-w-3xl space-y-3 text-[15px] leading-relaxed text-ink-soft break-words">
        {explainer.body.split(/\n\n+/).map((para, i) => (
          <p key={i}>{para.trim()}</p>
        ))}
      </div>

      {/* Cross-chain context table. Every sibling with its own explainer
          links to its dedicated page (internal mesh); chains without one
          deep-link to their anchor on the parent bench. */}
      {sorted.length > 1 && (
        <section className="mt-12 max-w-3xl">
          <h2 className="display text-2xl tracking-tight text-ink">
            How {result.name} compares
          </h2>
          <p className="mt-3 text-sm text-ink-muted">
            Live p50 over the last 24 hours across every chain on this
            benchmark, ranked{" "}
            {benchmark.higherIsBetter ? "highest" : "lowest"} first.
          </p>
          <ol className="mt-6 space-y-1">
            {sorted.map((r, i) => {
              const isCurrent = r.slug === chain;
              const href = explainerSlugs.has(r.slug)
                ? `/benchmarks/${benchmark.slug}/${r.slug}`
                : `/benchmarks/${benchmark.slug}#${r.slug}`;
              const row = (
                <span className="flex items-baseline justify-between gap-4">
                  <span className="flex items-baseline gap-3 min-w-0">
                    <span className="font-mono text-xs text-ink-faint w-6 shrink-0">
                      #{i + 1}
                    </span>
                    <span
                      className={
                        isCurrent ? "font-semibold text-ink" : "text-ink-soft"
                      }
                    >
                      {r.name}
                    </span>
                  </span>
                  <span className="font-mono text-sm text-ink">
                    {fmtUnit(r.ms.p50, benchmark.unit)}
                  </span>
                </span>
              );
              return (
                <li
                  key={r.slug}
                  className={`rounded-md px-3 py-2 ${
                    isCurrent ? "card-soft" : ""
                  }`}
                >
                  {isCurrent ? (
                    row
                  ) : (
                    <Link href={href} className="block hover:text-ink">
                      {row}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <p className="mt-10 text-sm text-ink-muted">
        Methodology, charts and the full ledger live on the{" "}
        <Link href={`/benchmarks/${benchmark.slug}`} className="lnk">
          {benchmark.title}
        </Link>{" "}
        page. Raw data:{" "}
        <a className="lnk" href={`/api/stat/${benchmark.slug}`}>
          JSON endpoint
          <ArrowUpRight size={12} strokeWidth={2} className="inline ml-1" />
        </a>
        .
      </p>
    </article>
  );
}
