import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, ChevronDown } from "lucide-react";
import {
  getBenchmark,
  getBenchmarks,
  getBenchmarkSlugs,
} from "@/data/benchmarks";
import { Pill } from "@/components/pill";
import { BenchmarkBody } from "@/components/benchmark-body";
import { ChainHeadingsSummary } from "@/components/chain-headings-summary";
import { CitationBar } from "@/components/citation-bar";
import { LiveIndicator } from "@/components/live-indicator";
import { ShareSection } from "@/components/share-section";
import { ReportSection } from "@/components/report-section";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import { headlineSentence } from "@/lib/citation";
import { SITE } from "@/data/site";
import { safeJsonLd } from "@/lib/jsonld";
import type { Benchmark } from "@/types/benchmark";

export const revalidate = 60;

type Params = { slug: string };

export async function generateStaticParams() {
  const slugs = await getBenchmarkSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const b = await getBenchmark(slug);
  if (!b) return {};
  const metaTitle = b.seoTitle ?? b.title;
  // Description precedence (most-to-least specific):
  //   1. `seo_description` from the YAML - hand-crafted snippet with the
  //      long-tail query phrases we want to rank for.
  //   2. `headlineSentence(b) + subtitle` - auto-generated citable hook
  //      from the current leader's measured value.
  //   3. Just `subtitle` - when the bench has no live data yet.
  const sentence = headlineSentence(b);
  const description =
    b.seoDescription ?? (sentence ? `${sentence} ${b.subtitle}` : b.subtitle);
  const url = `${SITE.url}/benchmarks/${b.slug}`;
  return {
    title: metaTitle,
    description,
    alternates: { canonical: url },
    openGraph: { title: metaTitle, description, type: "article", url },
    twitter: { card: "summary_large_image", title: metaTitle, description },
  };
}

export default async function BenchmarkPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<{ chain?: string; region?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;

  // Resolve the dimension filters against what the spec declares. Each
  // dimension defaults to its first option (typically `all`) when the
  // URL doesn't specify one.
  const aggregate = await getBenchmark(slug);
  if (!aggregate) notFound();
  const chainOptions = aggregate.dimensions?.chain ?? [];
  const regionOptions = aggregate.dimensions?.region ?? [];
  // 404 on unknown ?chain= / ?region= so the page can't be cached at the
  // ISR layer per garbage value. Falling through to the default option
  // used to produce a 200 with default render, blowing up cache cardinality.
  if (typeof sp.chain === "string" && sp.chain && !chainOptions.find((c) => c.value === sp.chain)) {
    notFound();
  }
  if (typeof sp.region === "string" && sp.region && !regionOptions.find((r) => r.value === sp.region)) {
    notFound();
  }
  const matchedChain =
    chainOptions.find((c) => c.value === sp.chain)?.value ??
    chainOptions[0]?.value ??
    null;
  const matchedRegion =
    regionOptions.find((r) => r.value === sp.region)?.value ??
    regionOptions[0]?.value ??
    null;
  const chain = chainOptions.length > 0 ? matchedChain : null;
  const region = regionOptions.length > 0 ? matchedRegion : null;

  // Pre-fetch every (chain × region) variant in parallel so client flips
  // are zero round-trip. unstable_cache dedupes each (slug, filters) combo
  // across users - first miss warms it, every later viewer gets it instant.
  // `all` is the "no filter" sentinel - same as the unscoped fetch.
  const chainsForFetch = chainOptions.length > 0 ? chainOptions.map((c) => c.value) : [null];
  const regionsForFetch = regionOptions.length > 0 ? regionOptions.map((r) => r.value) : [null];

  const variantPairs = chainsForFetch.flatMap((c) =>
    regionsForFetch.map((r) => [c, r] as const)
  );
  const [variantList, all] = await Promise.all([
    Promise.all(
      variantPairs.map(async ([c, r]) => {
        const filters: { chain?: string; region?: string } = {};
        if (c && c !== "all") filters.chain = c;
        if (r && r !== "all") filters.region = r;
        const b = await getBenchmark(slug, filters);
        return [variantKey(c, r), b ?? aggregate] as const;
      })
    ),
    getBenchmarks(),
  ]);
  const variants: Record<string, Benchmark> = Object.fromEntries(variantList);
  const benchmark = variants[variantKey(chain, region)] ?? aggregate;

  const isDraft = benchmark.status === "draft";
  const isAwaiting = isDraft && benchmark.editorialStatus === "live";
  // Cap the "more benchmarks" rail at 6 items so it doesn't turn into
  // an endless single-column scroll on mobile (with 18 benches the old
  // unlimited list rendered 17 full cards stacked). Prefer same-category
  // siblings first, pad with cross-category benches if needed, then
  // surface a "View all" link to /benchmarks for full discovery.
  const otherAll = all.filter((b) => b.slug !== benchmark.slug);
  const sameCat = otherAll.filter((b) => b.category === benchmark.category);
  const otherCat = otherAll.filter((b) => b.category !== benchmark.category);
  const otherBenchmarks = [...sameCat, ...otherCat].slice(0, 6);
  const hasMoreToShow = otherAll.length > otherBenchmarks.length;

  const catColor = CATEGORY_COLOR[benchmark.category];

  const benchmarkUrl = `${SITE.url}/benchmarks/${benchmark.slug}`;
  const sentence = headlineSentence(benchmark);
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Dataset",
        "@id": `${benchmarkUrl}#dataset`,
        name: benchmark.seoTitle ?? benchmark.title,
        alternateName: benchmark.title,
        description: benchmark.abstract,
        url: benchmarkUrl,
        identifier: benchmark.slug,
        keywords: [
          benchmark.category,
          benchmark.metric,
          ...benchmark.results.map((r) => r.name),
          "live benchmark",
          "crypto infrastructure",
        ].join(", "),
        creator: { "@id": `${SITE.url}/#org` },
        publisher: { "@id": `${SITE.url}/#org` },
        isAccessibleForFree: true,
        license: "https://creativecommons.org/licenses/by/4.0/",
        dateModified: benchmark.lastRunAt,
        variableMeasured: benchmark.metric,
        distribution: [
          {
            "@type": "DataDownload",
            encodingFormat: "application/json",
            contentUrl: `${SITE.url}/api/stat/${benchmark.slug}`,
          },
        ],
        measurementTechnique: benchmark.methodology.join(" "),
      },
      {
        "@type": "TechArticle",
        "@id": `${benchmarkUrl}#article`,
        headline: benchmark.title,
        description: benchmark.subtitle,
        url: benchmarkUrl,
        mainEntityOfPage: benchmarkUrl,
        articleBody: sentence,
        dateModified: benchmark.lastRunAt,
        author: { "@id": `${SITE.url}/#org` },
        publisher: { "@id": `${SITE.url}/#org` },
        about: { "@id": `${benchmarkUrl}#dataset` },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Home",
            item: SITE.url,
          },
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
        ],
      },
      // FAQPage entry is emitted only when the spec declares `faq:`. Google
      // requires every Question/Answer pair to also appear visibly on the
      // page - the FaqSection below renders them, so the JSON-LD is honest.
      ...(benchmark.faq && benchmark.faq.length > 0
        ? [
            {
              "@type": "FAQPage",
              "@id": `${benchmarkUrl}#faq`,
              mainEntity: benchmark.faq.map((item) => ({
                "@type": "Question",
                name: item.q,
                acceptedAnswer: {
                  "@type": "Answer",
                  text: item.a,
                },
              })),
            },
          ]
        : []),
    ],
  };

  return (
    <article className="mx-auto max-w-5xl px-4 sm:px-6 pt-10 sm:pt-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      {/* Visible breadcrumb trail - duplicates the JSON-LD BreadcrumbList
          so Google can show the crumb above the URL in the SERP. */}
      <nav
        aria-label="Breadcrumb"
        className="mb-3 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-faint"
      >
        <ol className="flex flex-wrap items-center gap-1.5">
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
          <li className="text-ink-muted">{benchmark.title}</li>
        </ol>
      </nav>

      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/#latest"
          className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          All benchmarks
        </Link>
        {!isDraft && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <ShareSection
              slug={benchmark.slug}
              title={benchmark.title}
              benchmark={benchmark}
              chain={chain}
            />
            <ReportSection slug={benchmark.slug} />
          </div>
        )}
      </div>

      {/* Bench identifier - minimal mono line, no SaaS-style pills. */}
      <div className="mt-6 flex flex-wrap items-center gap-3 font-sans text-[11px] uppercase tracking-[0.18em] text-ink-muted font-medium">
        <span style={{ color: catColor ?? "var(--color-ink-soft)" }}>
          {benchmark.category}
        </span>
        {isDraft && (
          <span className="text-ink-faint">
            {isAwaiting ? "awaiting samples" : "draft"}
          </span>
        )}
        {!isDraft && (
          <span className="ml-auto">
            <LiveIndicator lastRunAt={benchmark.lastRunAt} slug={benchmark.slug} />
          </span>
        )}
      </div>

      {/* Title */}
      <h1 className="mt-5 display text-3xl sm:text-4xl md:text-5xl tracking-tight text-ink">
        {benchmark.title}
      </h1>
      <p className="mt-4 max-w-3xl text-lg sm:text-xl text-ink-muted leading-snug">
        {benchmark.subtitle}
      </p>

      {/* Disclaimer callout, rendered before the SEO intro so it
          catches the eye BEFORE the reader scrolls to the leaderboard.
          Optional, used on benches where the metric is easy to misread
          (e.g. gas oracle prediction error, where lower-is-better hides
          a deliberate over-pay trade-off). */}
      {benchmark.disclaimer && (
        <div
          role="note"
          className="mt-6 max-w-3xl rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-[14px] leading-relaxed text-ink"
        >
          <p className="label-mono mb-1 text-warn">Read this carefully</p>
          <p>{benchmark.disclaimer}</p>
        </div>
      )}

      {/* SEO-tuned intro paragraph rendered server-side under the H1 so
          long-tail query phrases land in the first ~200 words crawlers
          weight heavily. Optional - omitted when the YAML doesn't set it. */}
      {benchmark.seoIntro && (
        <div className="mt-6 max-w-3xl space-y-3 text-[15px] leading-relaxed text-ink-soft">
          {benchmark.seoIntro
            .split(/\n\n+/)
            .map((para, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <p key={i}>{para.trim()}</p>
            ))}
        </div>
      )}

      {/* Citation affordances. one click takes a journalist or agent from
          the page to a pasteable quote or a JSON endpoint. */}
      {!isDraft && <CitationBar benchmark={benchmark} />}

      {/* Methodology - expanded by default so readers can verify the
          measurement before reading the numbers. Collapsible for repeat
          visitors who already know the harness. */}
      {!isDraft && (
        <details
          open
          className="mt-8 group card-soft px-5 py-1"
        >
          <summary className="flex cursor-pointer items-center justify-between py-3 list-none">
            <span className="label-mono text-ink">
              Methodology
            </span>
            <ChevronDown
              size={16}
              strokeWidth={2}
              className="text-ink-muted transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="pb-4 pt-1">
            <p className="text-sm leading-relaxed text-ink-soft max-w-3xl">
              {benchmark.abstract}
            </p>
          </div>
        </details>
      )}

      {/* Body: chain tabs + summary + chart + ledger + share. Receives every
          chain variant pre-fetched server-side. flipping a tab swaps which
          variant is rendered, instantly, no network round-trip. */}
      {!isDraft && (
        <BenchmarkBody
          variants={variants}
          chainOptions={chainOptions}
          regionOptions={regionOptions}
          initialChain={chain ?? null}
          initialRegion={region ?? null}
        />
      )}

      {isDraft && <DraftNotice source={benchmark.source} />}

      {/* SEO-friendly per-chain H2 block. Renders server-side so the
          long-tail "Ethereum finality time", "Solana finality time"
          phrases land in static HTML for crawlers to index. */}
      {!isDraft && <ChainHeadingsSummary benchmark={benchmark} />}

      {/* FAQ section - every question/answer mirrors a FAQPage JSON-LD
          entry above. Google requires the content to be visible on the
          page, so we render the same text here. */}
      {!isDraft && benchmark.faq && benchmark.faq.length > 0 && (
        <section className="mt-16 max-w-3xl">
          <h2 className="display text-2xl tracking-tight text-ink">
            Frequently asked
          </h2>
          <div className="mt-6 space-y-3">
            {benchmark.faq.map((item) => (
              <details
                key={item.q}
                className="group card-soft px-5 py-4 [&_summary]:cursor-pointer [&_summary::-webkit-details-marker]:hidden [&_summary]:list-none"
              >
                <summary className="flex items-center justify-between gap-4 text-base font-semibold text-ink">
                  <span>{item.q}</span>
                  <ChevronDown
                    size={18}
                    strokeWidth={2}
                    className="shrink-0 text-ink-muted transition-transform duration-200 group-open:rotate-180"
                  />
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </section>
      )}

      {/* Source code link. bottom of page */}
      {!isDraft && (
        <p className="mt-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
          Source code{" "}
          <a className="lnk" href={benchmark.source}>
            {benchmark.source.replace("https://github.com/", "github.com/")}
            <ArrowUpRight size={12} strokeWidth={2} className="inline ml-1" />
          </a>
        </p>
      )}

      {/* Other benchmarks */}
      {otherBenchmarks.length > 0 && (
        <nav className="mt-16 sm:mt-20 pt-8">
          <div className="flex items-baseline justify-between gap-4">
            <h3 className="label-mono text-ink-muted">
              More benchmarks
            </h3>
            {hasMoreToShow && (
              <Link
                href="/benchmarks"
                className="label-mono text-ink-muted hover:text-ink transition-colors"
              >
                View all →
              </Link>
            )}
          </div>
          <ul className="mt-5 grid gap-4 sm:grid-cols-2 items-stretch">
            {otherBenchmarks.map((b) => (
              <li key={b.slug} className="flex">
                <Link
                  href={`/benchmarks/${b.slug}`}
                  className="flex-1 card-soft rounded-xl p-4 sm:p-5 flex flex-col"
                >
                  <div className="flex items-center gap-2">
                    <Pill variant={b.status === "live" ? "live" : "draft"} pulse>
                      {b.status === "live" ? "Live" : "Draft"}
                    </Pill>
                    <Pill variant="category">{b.category}</Pill>
                  </div>
                  <p className="mt-3 display text-base sm:text-lg font-bold leading-tight text-ink">
                    {b.title}
                  </p>
                  <p className="mt-2 text-sm text-ink-muted line-clamp-2 flex-1">
                    {b.subtitle}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </article>
  );
}

/** Stable variant-map key. Mirrors what BenchmarkBody computes on every
 * filter change. Use `null` for "no dimension" and "all" / undefined as
 * the unscoped sentinel. */
function variantKey(chain: string | null, region: string | null): string {
  return `${chain ?? "__none"}|${region ?? "__none"}`;
}

function DraftNotice({ source }: { source: string }) {
  return (
    <div className="mt-10 card p-6 text-center">
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
        Draft. no live data yet
      </p>
      <p className="mt-3 text-sm text-ink-muted">
        The spec is published. Numbers will appear here as soon as the harness
        starts emitting metrics.
      </p>
      <a
        href={source}
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium lnk"
      >
        Source code
        <ArrowUpRight size={12} strokeWidth={2} />
      </a>
    </div>
  );
}
