import { Suspense } from "react";
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

// Cold start render does up to ~200 Prom calls (provider × percentiles ×
// series queries) which can exceed Vercel's default 10s function timeout
// on benches with 20+ providers. Once ISR warms, the page is cached and
// fast — this only affects the first hit per revalidate window. Bumped
// to 60s to absorb the slow cold path. The actual hot path latency is
// served from the CDN cache so the user-facing P99 stays sub-second.
export const maxDuration = 60;

type Params = { slug: string };

export async function generateStaticParams() {
  const slugs = await getBenchmarkSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { slug } = await params;
  // Next 16 ships searchParams as a Promise. Reading it here would normally
  // tip the segment into "dynamic", but generateMetadata is allowed to
  // consume request data without affecting the parent page's static
  // rendering — the page.tsx body still resolves searchParams client-side
  // through BenchmarkBody.
  const sp = (await searchParams) ?? {};
  const rawChain = Array.isArray(sp.chain) ? sp.chain[0] : sp.chain;
  // Always re-fetch unfiltered first — used for canonical fields and the
  // default copy. When a chain is requested, fetch the filtered variant
  // so headline sentence + template placeholders resolve against the
  // chain-scoped leader rather than the cross-chain aggregate.
  const baseBench = await getBenchmark(slug);
  if (!baseBench) return {};
  const chainOption = (baseBench.dimensions?.chain ?? []).find(
    (c) => c.value.toLowerCase() === (rawChain ?? "").toLowerCase(),
  );
  const isChainScoped = Boolean(chainOption && chainOption.value !== "all");
  const filteredBench = isChainScoped
    ? (await getBenchmark(slug, { chain: chainOption!.value })) ?? baseBench
    : baseBench;
  // Use the filtered bench for headline + template substitutions so the
  // OG/Twitter card and meta description reference the chain-specific
  // leader rather than the cross-chain aggregate (the headline of the
  // unfiltered bench is misleading when a single chain dominates the
  // baseline — e.g. Solana skewing the "fastest data API" claim on the
  // Bench-001 aggregate view).
  const b = filteredBench;
  const chainLabel = chainOption?.label ?? null;
  const baseTitle = b.seoTitle ?? b.title;
  const metaTitle = isChainScoped && chainLabel
    ? `${baseTitle} on ${chainLabel}`
    : baseTitle;
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
  // Canonical NEVER carries `?chain=...`. Per-chain variants share the
  // same canonical URL so Google consolidates link signal on the hub
  // page instead of treating each tab as a separate document. The OG
  // url is the chain-scoped one so social previews don't all collapse
  // to the same target.
  const canonical = `${SITE.url}/benchmarks/${baseBench.slug}`;
  const ogUrl = isChainScoped
    ? `${canonical}?chain=${chainOption!.value}`
    : canonical;
  return {
    title: metaTitle,
    description,
    alternates: { canonical },
    // Any URL with a filter query param (?chain=…, ?region=…) points its
    // canonical at the unfiltered hub. We also noindex these variants
    // directly — Google otherwise sees multiple competing URLs for the
    // same canonical, which reads as duplicate-content gaming and waters
    // down the hub's authority. `follow` stays on so chain pages are
    // still discoverable via internal links.
    //
    // We check the RAW query params (not just `isChainScoped`) so that
    // `?chain=foo` for an unknown chain is also noindexed — Google could
    // otherwise stumble onto an out-of-scope chain via a stale internal
    // link and treat the resulting page as a thin near-duplicate.
    robots:
      sp.chain !== undefined || sp.region !== undefined
        ? { index: false, follow: true }
        : { index: true, follow: true },
    openGraph: {
      title: metaTitle,
      description,
      type: "article",
      url: ogUrl,
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

  // Pre-fetch every (chain × region × kind) variant in parallel so client flips
  // are zero round-trip. unstable_cache dedupes each (slug, filters) combo
  // across users - first miss warms it, every later viewer gets it instant.
  // `all` is the "no filter" sentinel - same as the unscoped fetch.
  const chainsForFetch = chainOptions.length > 0 ? chainOptions.map((c) => c.value) : [null];
  const regionsForFetch = regionOptions.length > 0 ? regionOptions.map((r) => r.value) : [null];
  const kindsForFetch = kindOptions.length > 0 ? kindOptions.map((k) => k.value) : [null];

  const variantPairs = chainsForFetch.flatMap((c) =>
    regionsForFetch.flatMap((r) =>
      kindsForFetch.map((k) => [c, r, k] as const)
    )
  );
  const [variantList, all] = await Promise.all([
    Promise.all(
      variantPairs.map(async ([c, r, k]) => {
        const filters: { chain?: string; region?: string; kind?: string } = {};
        if (c && c !== "all") filters.chain = c;
        if (r && r !== "all") filters.region = r;
        if (k && k !== "all") filters.kind = k;
        const b = await getBenchmark(slug, filters);
        return [variantKey(c, r, k), b ?? aggregate] as const;
      })
    ),
    getBenchmarks(),
  ]);
  // Variants only contribute chart / leaderboard / extras to the displayed
  // bench (those legitimately differ per (chain, region) filter). Editorial
  // copy (findings, faq, seoIntro, abstract, methodology) is the SAME on
  // every tab and only resolves chain placeholders against the aggregate's
  // bestPerChain/worstPerChain stash (computed unfiltered only), so we
  // override these fields onto every variant. Without this, switching to
  // a chain tab surfaces raw `{{best_name:chain:X}}` strings.
  const variants: Record<string, Benchmark> = Object.fromEntries(
    variantList.map(([key, v]) => [
      key,
      v === aggregate
        ? v
        : {
            ...v,
            findings: aggregate.findings,
            faq: aggregate.faq,
            seoIntro: aggregate.seoIntro,
            abstract: aggregate.abstract,
            methodology: aggregate.methodology,
            perChainExplainer: aggregate.perChainExplainer,
            bestPerChain: aggregate.bestPerChain,
            worstPerChain: aggregate.worstPerChain,
          },
    ]),
  );
  const benchmark = variants[variantKey(chain, region, kind)] ?? aggregate;

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
