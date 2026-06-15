import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, ChevronDown } from "lucide-react";
import { getBenchmark, getBenchmarks } from "@/data/benchmarks";
import { Pill } from "@/components/pill";
import { BenchmarkBody } from "@/components/benchmark-body";
import { ChainHeadingsSummary } from "@/components/chain-headings-summary";
import { OraclePairMatrix } from "@/components/oracle-pair-matrix";
import { CitationBar } from "@/components/citation-bar";
import { LiveIndicator } from "@/components/live-indicator";
import { ShareSection } from "@/components/share-section";
import { ExportVideoSection } from "@/components/export-video-section";
import { ReportSection } from "@/components/report-section";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import { headlineSentence } from "@/lib/citation";
import { capDescription } from "@/lib/seo-text";
import { getBenchCreatedAt } from "@/lib/seo/bench-dates";
import { SITE } from "@/data/site";
import { buildFaqPageJsonLd, safeJsonLd } from "@/lib/jsonld";
import { renderTemplate } from "@/lib/bench-template";
import type { Benchmark } from "@/types/benchmark";

// ISR with a 60 s revalidate window. The page is prerendered by
// generateStaticParams below and served from the CDN until 60 s after
// the last render, after which the next request triggers a background
// regeneration that swaps the cached HTML in place.
//
// Why not `force-static`: the page composes the "More benchmarks" rail
// from `loadAllBenchmarks()`, which calls Prom for every spec. With
// pure force-static the HTML is frozen at deploy time — if a single
// bench was in a transient draft state during the deploy build, that
// "DRAFT" pill stays on every visitor's screen until the next deploy.
// ISR + the per-bench unstable_cache + the KV snapshot fallback in
// spec.ts together mean every regeneration either gets fresh Prom data,
// reads the last good snapshot from KV, or preserves the previous
// cached page — never poisons the rail with a transient draft.
//
// `dynamic` is not pinned to "force-static" anymore: client subtrees
// using useSearchParams (BenchmarkBody, wrapped in Suspense) won't
// flip the route to fully dynamic because they're behind Suspense, so
// the route still prerenders cleanly.
export const revalidate = 60;

// Cold start render does thousands of Prom calls on the heaviest benches
// (hyperliquid-frontends: 75 providers × 7 queries + 11 panels × values +
// series), serialized through the Prom client's concurrency cap. At 60s
// the ISR regeneration itself was killed ("Vercel Runtime Timeout Error:
// Task timed out after 60 seconds"), so the cache could NEVER replace a
// build-time render that had failed its panel queries — staging served
// empty panel values for hours (2026-06-11). 300s gives the regeneration
// room to finish; the hot path is CDN-cached and stays sub-second.
export const maxDuration = 300;

type Params = { slug: string };

// Rendered ON DEMAND (first request, then ISR-cached). Prerendering the
// 25+ bench pages at build pushed the full multi-bench Prom load through
// the CI runner, whose DNS resolver throttles under hundreds of lookups;
// observed 2026-06-11: /benchmarks/pm-data-freshness failing 3×60s
// export attempts and killing the deploy. Without the embedded variant
// matrix an on-demand first render is a few seconds once per deploy per
// slug, then the CDN serves it.
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  // DO NOT read searchParams here. Awaiting it in generateMetadata opts
  // the whole route into dynamic rendering (`cache-control: no-store`,
  // zero CDN caching) — measured at 43s TTFB on cold rpc-capabilities
  // hits. Chain-scoped metadata lives on the dedicated
  // /benchmarks/[slug]/[chain] pages; `?chain=` URLs on this route share
  // the aggregate metadata and the canonical, which is what we want for
  // link-signal consolidation anyway.
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
  let description =
    b.seoDescription ?? (sentence ? `${sentence} ${b.subtitle}` : b.subtitle);
  // Resolve any template placeholders ({{best_name}}, {{best_p50}}, ...)
  // against the (possibly chain-scoped) bench so editorial copy in the
  // description renders with live, chain-honest numbers. seoDescription
  // is the most common host for these placeholders.
  if (description) description = renderTemplate(description, b);
  // Google truncates meta descriptions at ~155-160 chars in the SERP. Anything
  // longer is cut mid-word which hurts CTR. Trim cleanly so we control the
  // truncation rather than letting Google decide where to slice.
  if (description) description = capDescription(description, 158);
  // Canonical NEVER carries `?chain=...`. Per-chain variants live on the
  // dedicated /benchmarks/[slug]/[chain] pages with their own metadata.
  const canonical = `${SITE.url}/benchmarks/${b.slug}`;
  return {
    title: metaTitle,
    description,
    alternates: { canonical },
    openGraph: {
      title: metaTitle,
      description,
      type: "article",
      url: canonical,
    },
    twitter: { card: "summary_large_image", title: metaTitle, description },
  };
}

export default async function BenchmarkPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;

  // The page renders the no-filter ("all") view server-side and lets the
  // client component swap to a ?chain= / ?region= variant after hydration.
  // Reading searchParams here used to flip the route to fully dynamic,
  // which made vercel respond with `cache-control: private, no-store` on
  // every bench page - the slowest visit-by-visit story on the site. Going
  // fully static lets the CDN keep each /benchmarks/<slug> warm for the
  // 60 s revalidate window, so every region's edge serves the page in
  // sub-100 ms after one warm-up.
  const aggregate = await getBenchmark(slug);
  if (!aggregate) notFound();
  const chainOptions = aggregate.dimensions?.chain ?? [];
  const regionOptions = aggregate.dimensions?.region ?? [];
  const kindOptions = aggregate.dimensions?.kind ?? [];
  const chain = chainOptions[0]?.value ?? null;
  const region = regionOptions[0]?.value ?? null;
  const kind = kindOptions[0]?.value ?? null;

  // Variants (chain × region × kind) are NOT embedded anymore. The old
  // pre-fetch awaited every variant (rpc-capabilities: 39 full provider
  // loads) on EVERY ISR regeneration and shipped them all in the page
  // payload — regenerations took 30-60 s, and any visitor landing on a
  // blocking render path (post-deploy, cache eviction) ate that wait.
  // BenchmarkBody now fetches a variant on demand from
  // /api/bench/[slug]/variant when a tab is flipped (per-variant
  // unstable_cache keeps that at one cheap Prom roundtrip per 60 s
  // across all users), and renders the aggregate while it loads.
  const all = await getBenchmarks();
  // Seed ONLY the unfiltered key. Seeding the initially-selected
  // chain/region/kind combo with the aggregate made the client believe
  // it already had that variant, so it never fetched the real one: the
  // first tab (e.g. ?chain=bnb) silently rendered global data labeled
  // as per-chain. The client renders the aggregate as a placeholder
  // while the true variant loads from /api/bench/[slug]/variant.
  const variants: Record<string, Benchmark> = {
    [variantKey(null, null, null)]: aggregate,
  };
  const benchmark = aggregate;

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
        // Google Rich Results validator caps description at ~1000 chars even
        // though schema.org Dataset allows up to 5000. Keep it under 990 to
        // avoid the "Invalid string length" warning that strips rich snippets.
        description: capDescription(benchmark.abstract, 990),
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
        datePublished: getBenchCreatedAt(benchmark.slug).toISOString(),
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
        // Article rich results recommend an `image` field. We reuse the
        // dynamic OG card that already renders the leaderboard, so the
        // schema image matches what Search Console, X and LinkedIn show.
        // Clears the "Missing field image" warning in Rich Results Test.
        image: `${SITE.url}/api/og/${benchmark.slug}`,
        datePublished: getBenchCreatedAt(benchmark.slug).toISOString(),
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
    ],
  };

  // FAQPage is emitted as a standalone JSON-LD block (not nested inside
  // the @graph above). Both shapes validate, but Search Console
  // historically registers more rich-result hits on standalone FAQPage
  // scripts, and the @graph-nested variant we shipped previously netted
  // zero. Strip inline markdown from each answer so backticks and asterisks
  // don't leak into the SERP snippet. The visible FAQ section below
  // mirrors every question/answer, satisfying Google's "content visible
  // on the page" requirement.
  const faqJsonLd = buildFaqPageJsonLd(benchmark.faq, benchmarkUrl);

  return (
    <article className="mx-auto max-w-5xl w-full px-4 sm:px-6 pt-10 sm:pt-14 overflow-x-clip min-w-0">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      {faqJsonLd && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(faqJsonLd) }}
        />
      )}
      {/* Visible breadcrumb trail - duplicates the JSON-LD BreadcrumbList
          so Google can show the crumb above the URL in the SERP. */}
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
          <li className="text-ink-muted truncate max-w-[60vw] sm:max-w-none">
            {benchmark.title}
          </li>
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
            <ExportVideoSection
              slug={benchmark.slug}
              title={benchmark.title}
              benchmark={benchmark}
            />
            <ReportSection slug={benchmark.slug} />
          </div>
        )}
      </div>

      {/* Bench identifier - minimal mono line, no SaaS-style pills. */}
      <div className="mt-6 flex flex-wrap items-center gap-3 font-sans text-[11px] uppercase tracking-[0.1em] sm:tracking-[0.18em] text-ink-muted font-medium">
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
      <h1 className="mt-5 display text-3xl sm:text-4xl md:text-5xl tracking-tight text-ink break-words">
        {benchmark.title}
      </h1>
      <p className="mt-4 max-w-3xl text-lg sm:text-xl text-ink-muted leading-snug break-words">
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
        <div className="mt-6 max-w-3xl space-y-3 text-[15px] leading-relaxed text-ink-soft break-words">
          {benchmark.seoIntro
            .split(/\n\n+/)
            .map((para, i) => (
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
            <p className="text-sm leading-relaxed text-ink-soft max-w-3xl break-words">
              {benchmark.abstract}
            </p>
          </div>
        </details>
      )}

      {/* Body: chain tabs + summary + chart + ledger + share. Receives every
          chain variant pre-fetched server-side. flipping a tab swaps which
          variant is rendered, instantly, no network round-trip. */}
      {!isDraft && (
        <Suspense fallback={null}>
          <BenchmarkBody
            variants={variants}
            chainOptions={chainOptions}
            regionOptions={regionOptions}
            kindOptions={kindOptions}
            initialChain={chain ?? null}
            initialRegion={region ?? null}
            initialKind={kind ?? null}
          />
        </Suspense>
      )}

      {isDraft && <DraftNotice source={benchmark.source} />}

      {/* Bench-specific pivot view. oracle-deviation ranks assets by
          MAX deviation across all source pairs; this panel reveals
          which source pair drives each row so a tweet like "Chainlink
          SOL is 0.8% off Binance" maps to a visible cell on the page. */}
      {!isDraft && benchmark.slug === "oracle-deviation" && <OraclePairMatrix />}

      {/* SEO-friendly per-chain H2 block. Renders server-side so the
          long-tail "Ethereum finality time", "Solana finality time"
          phrases land in static HTML for crawlers to index. */}
      {!isDraft && <ChainHeadingsSummary benchmark={benchmark} />}

      {/* Dimension benches (chains as filters, not rows) don't render
          ChainHeadingsSummary, so the dedicated per-chain pages need
          their own server-rendered discovery links here. */}
      {!isDraft && <PerChainPagesNav benchmark={benchmark} />}

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

      {/* Source code link. bottom of page. The URL goes 'github.com/Org/Repo/tree/main/harnesses/<slug>'
          which can run to 80+ chars and overflows the viewport on mobile when uppercase + tracked.
          `break-all` wraps it character-by-character (no natural word boundaries inside a path);
          `max-w-full` clamps the inline anchor so flex parents don't blow out horizontally either. */}
      {!isDraft && (
        <p className="mt-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted break-all">
          Source code{" "}
          <a className="lnk inline max-w-full" href={benchmark.source}>
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
function variantKey(
  chain: string | null,
  region: string | null,
  kind: string | null,
): string {
  return `${chain ?? "__none"}|${region ?? "__none"}|${kind ?? "__none"}`;
}

/** Links to /benchmarks/<slug>/<chain> pages for dimension-shaped
 *  benches. Row-shaped benches (l1-finality) already link their pages
 *  through the ChainHeadingsSummary headings, so this only renders
 *  chains that exist as dimension values, not as result rows. */
function PerChainPagesNav({ benchmark }: { benchmark: Benchmark }) {
  const resultSlugs = new Set(benchmark.results.map((r) => r.slug));
  const explainerSlugs = new Set(
    (benchmark.perChainExplainer ?? []).map((e) => e.slug),
  );
  const chains = (benchmark.dimensions?.chain ?? []).filter(
    (c) =>
      c.value.toLowerCase() !== "all" &&
      explainerSlugs.has(c.value) &&
      !resultSlugs.has(c.value),
  );
  if (chains.length === 0) return null;
  return (
    <nav className="mt-12 max-w-3xl" aria-label="Per-chain pages">
      <h2 className="label-mono text-ink-muted">Per-chain breakdowns</h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {chains.map((c) => (
          <li key={c.value}>
            <Link
              href={`/benchmarks/${benchmark.slug}/${c.value}`}
              className="inline-block rounded-md card-soft px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
            >
              {c.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
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
