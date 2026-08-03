import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, ChevronDown } from "lucide-react";
import { getBenchmark, getBenchmarksSafe } from "@/data/benchmarks";
import { Pill } from "@/components/pill";
import { BenchmarkBody } from "@/components/benchmark-body";
import { BenchInfobox } from "@/components/bench-infobox";
import { BenchmarkBodySkeleton } from "@/components/benchmark-body-skeleton";
import { OraclePairMatrix } from "@/components/oracle-pair-matrix";
import { Breadcrumb } from "@/components/breadcrumb";
import { ChainHeadingsSummary } from "@/components/chain-headings-summary";
import { CompareThisBench } from "@/components/compare-this-bench";
import { CitationBar } from "@/components/citation-bar";
import { LiveIndicator } from "@/components/live-indicator";
import { ShareSection } from "@/components/share-section";
import { ExportVideoSection } from "@/components/export-video-section";
import { ReportSection } from "@/components/report-section";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import {
  citableAsOf,
  groundingTraceLine,
  groundingTraceParts,
  headlineSentence,
  isInsufficient,
  leader,
} from "@/lib/citation";
import { valueInDeclaredUnit } from "@/lib/format";
import { capDescription } from "@/lib/seo-text";
import { getBenchCreatedAt } from "@/lib/seo/bench-dates";
import { SITE } from "@/data/site";
import { buildBreadcrumbJsonLd, buildFaqPageJsonLd, safeJsonLd } from "@/lib/jsonld";
import {
  buildBenchDatasetJsonLd,
  buildBenchStatReportJsonLd,
  buildBenchVariableMeasured,
} from "@/lib/dataset-jsonld";
import { renderTemplate } from "@/lib/bench-template";
import { canonicalChainSlug } from "@/lib/chain-aliases";
import { PERSON_ID } from "@/lib/hub-jsonld";
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
// observed 2026-06-11: a bench page failing 3×60s
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
  // Editorially-live benches that are still waiting for their first
  // samples render as draft in the UI; letting Google index them means
  // the SERP snippet quotes "no live data yet" against a URL that is
  // meant to display a leaderboard. noindex/follow keeps the URL
  // crawlable (internal link equity + fast re-indexing when data lands)
  // without letting the empty state rank. Mirrors the render-time
  // `isAwaiting = isDraft && editorialStatus === "live"` gate below.
  const metaIsDraft = b.status === "draft";
  const metaIsAwaiting = metaIsDraft && b.editorialStatus === "live";
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
  // Highwire Press citation_* meta tags. Used by Google Scholar, Bing /
  // Copilot, Semantic Scholar and academic LLM tools to attach an
  // authoritative citation record to the page. Cheap to emit (single
  // digit KB) and materially boosts appearance in AI answer surfaces
  // that key on scholarly-style citation metadata. citation_pdf_url is
  // repurposed to point at the JSON stat endpoint since we do not ship
  // PDFs; the "pdf_url" name is historic, tools that consume the tag
  // accept any machine-readable representation.
  const isoPubDate = b.lastRunAt
    ? new Date(b.lastRunAt).toISOString().slice(0, 10)
    : undefined;
  return {
    title: metaTitle,
    description,
    alternates: { canonical },
    ...(metaIsAwaiting
      ? { robots: { index: false, follow: true } }
      : {}),
    openGraph: {
      title: metaTitle,
      description,
      type: "article",
      url: canonical,
      siteName: SITE.name,
    },
    twitter: {
      card: "summary_large_image",
      site: SITE.twitter,
      title: metaTitle,
      description,
    },
    other: {
      citation_title: metaTitle,
      citation_author: "OpenChainBench",
      citation_publisher: "OpenChainBench",
      ...(isoPubDate ? { citation_publication_date: isoPubDate } : {}),
      citation_doi: "10.5281/zenodo.20800312",
      citation_pdf_url: `${SITE.url}/api/stat/${b.slug}`,
      citation_public_url: canonical,
      citation_language: "en",
      citation_journal_title: "OpenChainBench",
    },
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
  const chainsWithData = new Set<string>(Object.keys(aggregate.providersPerChain ?? {}));
  const chainOptions =
    chainsWithData.size === 0
      ? (aggregate.dimensions?.chain ?? [])
      : (aggregate.dimensions?.chain ?? []).filter(
          (c) => c.value === "all" || chainsWithData.has(c.value),
        );
  // Drop declared regions that the harness doesn't actually emit data for
  // (e.g. metadata-coverage lists sgp in the spec but only ever publishes
  // region="unknown"). Without this the picker offers a tab that 404s on
  // every click and the chart silently falls back to the previous variant,
  // so two different region clicks render identical values.
  const declaredRegions = aggregate.dimensions?.region ?? [];
  // Snapshot region points are keyed by the spec entries' `region:` field
  // (historically `ap-southeast`) while dimension values use `sgp`. Without
  // canonicalizing, the data-presence filter below silently drops the
  // Singapore tab on every bench (regression introduced with the filter:
  // prod showed the tab before it shipped).
  const REGION_KEY_ALIASES: Record<string, string> = {
    "ap-southeast": "sgp",
    sgp: "sgp",
  };
  const canonRegion = (r: string) => REGION_KEY_ALIASES[r] ?? r;
  const regionsWithData = new Set<string>();
  for (const points of Object.values(aggregate.extras.regions ?? {})) {
    for (const pt of points as Array<{ region: string }>) {
      if (pt?.region) regionsWithData.add(canonRegion(pt.region));
    }
  }
  const sbr = aggregate.extras.seriesByRegion24h ?? {};
  for (const slug in sbr) {
    for (const r in sbr[slug]) {
      regionsWithData.add(canonRegion(r));
    }
  }
  const regionOptions =
    regionsWithData.size === 0
      ? []
      : declaredRegions.filter(
          (r) => r.value === "all" || regionsWithData.has(r.value),
        );
  const kindOptions = aggregate.dimensions?.kind ?? [];
  const venuesWithData = new Set<string>(aggregate.extras?.venuesWithData ?? []);
  const venueOptions =
    venuesWithData.size === 0
      ? (aggregate.dimensions?.venue ?? [])
      : (aggregate.dimensions?.venue ?? []).filter(
          (v) => v.value === "all" || venuesWithData.has(v.value),
        );
  const chain = chainOptions[0]?.value ?? null;
  const region = regionOptions[0]?.value ?? null;
  const kind = kindOptions[0]?.value ?? null;
  const venue = venueOptions[0]?.value ?? null;

  // Variants (chain × region × kind) are NOT embedded anymore. The old
  // pre-fetch awaited every variant (rpc-capabilities: 39 full provider
  // loads) on EVERY ISR regeneration and shipped them all in the page
  // payload — regenerations took 30-60 s, and any visitor landing on a
  // blocking render path (post-deploy, cache eviction) ate that wait.
  // BenchmarkBody now fetches a variant on demand from
  // /api/bench/[slug]/variant when a tab is flipped (per-variant
  // unstable_cache keeps that at one cheap Prom roundtrip per 60 s
  // across all users), and renders the aggregate while it loads.
  const all = await getBenchmarksSafe();
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
  // Insufficient: editorially live, runtime might say "live" too, but the
  // shared predicate decided no provider has a usable p50. Drives the
  // pill above the H1 and the headline degradation downstream.
  const insufficient = isInsufficient(benchmark);
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
  // Canonical grounding-trace line, computed once so the visible <p>
  // under H1, the StatisticalReport JSON-LD description and any future
  // LLM-facing endpoint quote identical wording. Skips its "As of ...
  // Source: ..." wrapper on insufficient / awaiting benches (returns the
  // bare status sentence) to avoid publishing a dated grounding trace
  // with no measurable claim.
  const groundingLine = groundingTraceLine(benchmark, SITE.url);
  // Same underlying computation, exposed as structured parts so the
  // visible TL;DR can wrap the ISO date in <time dateTime> for Perplexity
  // / Bing freshness ranking without recomputing the string.
  const trace = groundingTraceParts(benchmark, SITE.url);
  // Leader is null on draft / awaiting / insufficient. When null we
  // deliberately omit the StatisticalReport node from the @graph so we
  // never emit a structured "Observation" with a fabricated value.
  const currentLeader = leader(benchmark);
  // variableMeasured ships as an array so Google's Dataset validator
  // reports each statistical aggregate individually. When a defensible
  // leader exists the p50/p90/p99 aggregates ship as PropertyValue
  // objects with the numeric value in the declared unit, so Google
  // Dataset Search and academic LLM tools extract the measurement as a
  // structured fact rather than opaque axis labels. Drafts and
  // insufficient benches fall back to bare strings so we never publish
  // a fabricated numeric aggregate.
  const leaderResult = currentLeader
    ? benchmark.results.find((r) => r.slug === currentLeader.slug)
    : undefined;
  const variableMeasured = buildBenchVariableMeasured({
    metric: benchmark.metric,
    unit: benchmark.unit,
    leader:
      currentLeader && leaderResult
        ? {
            name: currentLeader.name,
            p50: valueInDeclaredUnit(leaderResult.ms.p50, benchmark.unit),
            p90: valueInDeclaredUnit(leaderResult.ms.p90, benchmark.unit),
            p99: valueInDeclaredUnit(leaderResult.ms.p99, benchmark.unit),
          }
        : null,
  });
  // Keep the inline creator/publisher from buildBenchDatasetJsonLd. An
  // earlier override rebound them to `{ "@id": ... }` references
  // pointing at the Organization emitted by layout.tsx, but Google
  // Search Console validates each Dataset in isolation - it does not
  // stitch cross-document @id refs - and flagged the reference-only
  // shape as "missing field creator" on /benchmarks/*. The inline Org
  // still shares the `@id` with the layout node so JSON-LD stitchers
  // (Perplexity, StatisticalReport isBasedOn) resolve them as one.
  const datasetNode = buildBenchDatasetJsonLd({
    slug: benchmark.slug,
    name: benchmark.seoTitle ?? benchmark.title,
    alternateName: benchmark.title,
    // Google Rich Results validator caps description at ~1000 chars even
    // though schema.org Dataset allows up to 5000. Keep it under 990 to
    // avoid the "Invalid string length" warning that strips rich snippets.
    description: capDescription(benchmark.abstract, 990),
    url: benchmarkUrl,
    variableMeasured,
    category: benchmark.category,
    datePublished: getBenchCreatedAt(benchmark.slug).toISOString(),
    // For drafts (no measurement history) skip dateModified so the
    // structured-data channel does not spoof freshness. Same rule
    // applied to /api/citable, /api/stat and the MCP surface.
    ...(citableAsOf(benchmark)
      ? { dateModified: benchmark.lastRunAt }
      : {}),
    measurementTechnique: benchmark.methodology.join(" "),
  });
  // StatisticalReport companion. Only emitted when we have a defensible
  // leader so the shape never publishes an Observation with a fabricated
  // measured value. temporalCoverage uses the ISO 8601 interval form:
  // <first-seen>/<last-scrape>, matching what schema.org expects.
  const statReportNode = currentLeader
    ? buildBenchStatReportJsonLd({
        slug: benchmark.slug,
        benchTitle: benchmark.seoTitle ?? benchmark.title,
        metric: benchmark.metric,
        metricUnit: benchmark.unit,
        leaderName: currentLeader.name,
        // Observation.measuredValue must be in unitText. Unit "s" benches
        // store ms internally; convert before publishing to JSON-LD.
        leaderValue: valueInDeclaredUnit(currentLeader.value, benchmark.unit),
        temporalCoverage: `${getBenchCreatedAt(benchmark.slug).toISOString()}/${benchmark.lastRunAt}`,
        observationDate: benchmark.lastRunAt,
        url: benchmarkUrl,
        // methodology[0] is the harness cadence line, which reads as a
        // compact "how we measure this" one-liner. Falls back to the
        // metric label so the field is never empty.
        measurementTechnique: benchmark.methodology[0] ?? benchmark.metric,
        description: groundingLine,
      })
    : null;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      datasetNode,
      ...(statReportNode ? [statReportNode] : []),
      {
        "@type": "TechArticle",
        "@id": `${benchmarkUrl}#article`,
        name: benchmark.title,
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
        ...(citableAsOf(benchmark)
          ? { dateModified: benchmark.lastRunAt }
          : {}),
        // Dual author: named maintainer first (E-E-A-T signal for AI
        // answer surfaces + Search Console) followed by the Org so the
        // institutional attribution still holds. reviewedBy anchors the
        // same Person as the accountable reviewer of the on-page claims.
        author: [{ "@id": PERSON_ID }, { "@id": `${SITE.url}/#org` }],
        reviewedBy: { "@id": PERSON_ID },
        publisher: { "@id": `${SITE.url}/#org` },
        // `about` describes the topic. Use a Thing (matches the
        // StatisticalReport `about` pattern above) rather than @id-refing
        // the same-page Dataset. Google's Dataset validator was flagging
        // @id-only refs as standalone incomplete Datasets even within
        // the same @graph (see the isBasedOn fix in dataset-jsonld.ts).
        about: { "@type": "Thing", name: benchmark.metric },
      },
      buildBreadcrumbJsonLd([
        { name: "Home", item: SITE.url },
        { name: "Benchmarks", item: `${SITE.url}/benchmarks` },
        { name: benchmark.title, item: benchmarkUrl },
      ]),
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
  const faqJsonLd = buildFaqPageJsonLd(
    benchmark.faq,
    benchmarkUrl,
    null,
    `${benchmark.title}: frequently asked questions`,
  );

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
      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: "Benchmarks", href: "/benchmarks" },
          { label: benchmark.title },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/#latest"
          className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          All benchmarks
        </Link>
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
        {!isDraft && insufficient && (
          <span className="text-ink-faint">insufficient samples</span>
        )}
        {!isDraft && !insufficient && (
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

      {/* Compact "At a glance" card. Rendered as a native <details>
          element so it collapses to a one line summary on click while
          still shipping the full microdata + key/value pairs inside the
          collapsed body (LLM crawlers see the content whatever the
          visual state). Sits between the subtitle and the TL;DR
          grounding trace so a reader has: headline claim (H1) → context
          (subtitle) → at-a-glance facts (this card) → canonical
          grounding sentence (TL;DR) before entering the leaderboard
          body. */}
      <BenchInfobox benchmark={benchmark} />

      {/* Visible grounding-trace TL;DR. Renders the same canonical line
          that ships in the StatisticalReport JSON-LD description and in
          /api/llm-context, so a language model summarising the page
          quotes identical wording whether it read the DOM, the schema
          block or the LLM-facing API. Only rendered when the bench has
          a defensible leader; on draft / insufficient / awaiting rows
          we omit the block entirely (the dated "As of ..." wrapper
          would otherwise read as broken quote to a summariser). The
          `data-llm-canonical` attribute is a soft signal some model
          agents use as a preferred extraction anchor when picking a
          quotable span. */}
      {currentLeader && trace && (
        <section
          id="tldr"
          data-llm-canonical="true"
          className="mt-6 max-w-3xl rounded-lg border border-ink/10 bg-paper-soft/40 px-4 py-3"
        >
          <p className="text-[13px] text-ink-muted leading-relaxed">
            <span className="font-medium text-ink">TL;DR.</span> As of{" "}
            <time dateTime={trace.isoDate}>{trace.isoDate}</time>,{" "}
            {trace.claim}. Source: OpenChainBench, {trace.url}.
          </p>
        </section>
      )}

      {/* Companion hub callout. A handful of benches have a curated
          landing page that sits next to (not in place of) the bench
          itself. For hyperliquid-frontends, /hyperliquid is the
          cohort-level leaderboard for the 104 tracked builders, plus
          per-builder dashboards on /products/<slug>. We surface it
          here so a reader landing on the bench from search has an
          obvious next step. Hard-coded by slug intentionally: the
          match rules are trivial (one slug + one suffix), a spec
          field would be overkill. The RPC cluster (rpc-capabilities
          + every <chain>-rpc bench) gets the same treatment pointing
          at the /rpc cross-chain matrix. */}
      {benchmark.slug === "hyperliquid-frontends" && (
        <div
          className="mt-6 max-w-3xl rounded-lg border border-ink/15 px-4 py-3 flex items-start gap-3 flex-wrap"
          style={{
            background:
              "linear-gradient(180deg, rgba(157,101,255,0.06), rgba(157,101,255,0.01))",
          }}
        >
          <span
            className="mt-0.5 inline-block w-2 h-2 rounded-full shrink-0"
            style={{ background: "#9d65ff" }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="label-mono text-[10px] text-ink-faint mb-0.5">
              Companion page
            </p>
            <p className="text-sm text-ink leading-snug">
              Looking for the cohort leaderboard or a single frontend&apos;s
              live dashboard?{" "}
              <Link
                href="/hyperliquid"
                className="font-semibold underline underline-offset-2"
                style={{ color: "#7a47db" }}
              >
                Open the Hyperliquid frontends hub →
              </Link>
            </p>
          </div>
        </div>
      )}
      {(benchmark.slug.endsWith("-rpc") ||
        benchmark.slug === "rpc-capabilities") && (
        <div
          className="mt-6 max-w-3xl rounded-lg border border-ink/15 px-4 py-3 flex items-start gap-3 flex-wrap"
          style={{
            background:
              "linear-gradient(180deg, rgba(14,165,233,0.06), rgba(14,165,233,0.01))",
          }}
        >
          <span
            className="mt-0.5 inline-block w-2 h-2 rounded-full shrink-0"
            style={{ background: "#0ea5e9" }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="label-mono text-[10px] text-ink-faint mb-0.5">
              Companion page
            </p>
            <p className="text-sm text-ink leading-snug">
              Comparing free RPC endpoints across every chain we measure?{" "}
              <Link
                href="/rpc"
                className="font-semibold underline underline-offset-2"
                style={{ color: "#0284c7" }}
              >
                Open the cross-chain RPC matrix →
              </Link>
            </p>
          </div>
        </div>
      )}

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

      {/* Live-feed outage banner. Renders when the spec declared
          live_activity queries and one or more providers came back
          "down" (short-window activity = 0, bench-level probe_ok
          confirmed our end is fine). Placed above the fold so a reader
          landing on the page during an incident sees the caveat before
          reading last-known percentiles as current truth. */}
      {(() => {
        const downProviders = benchmark.results.filter(
          (r) => r.liveStatus === "down"
        );
        if (downProviders.length === 0) return null;
        const names = downProviders.map((r) => r.name).join(", ");
        return (
          <div
            role="status"
            className="mt-6 max-w-3xl rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-[14px] leading-relaxed text-ink"
          >
            <p className="label-mono mb-1 text-danger">
              Live feed silent: {names}
            </p>
            <p>
              No new events received from{" "}
              {downProviders.length === 1 ? "this feed" : "these feeds"} in
              the last several minutes. Percentiles and rankings shown are
              the last-known values from the 24-hour window and update as
              soon as fresh events resume.
            </p>
          </div>
        );
      })()}

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
        <Suspense fallback={<BenchmarkBodySkeleton />}>
          <BenchmarkBody
            variants={variants}
            chainOptions={chainOptions}
            regionOptions={regionOptions}
            kindOptions={kindOptions}
            venueOptions={venueOptions}
            venuesForChain={aggregate.extras?.venuesForChain}
            initialChain={chain ?? null}
            initialRegion={region ?? null}
            initialKind={kind ?? null}
            initialVenue={venue ?? null}
            hasLongHistory={benchmark.slug === "hyperliquid-frontends"}
            pageActions={
              !isDraft ? (
                <>
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
                </>
              ) : undefined
            }
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

      {!isDraft && <CompareThisBench benchmark={benchmark} />}

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

/** Links to /benchmarks/<slug>/<sub> pages for every explainer entry
 *  that has a resolvable target on the bench. Three shapes:
 *    (a) Dimension chain — chain filter values that have an explainer.
 *    (b) Row-shape non-Blockchains — result rows that have an
 *        explainer but sit outside the "Blockchains" category (e.g.
 *        polymarket-resolution-delay categories, pm-* venues). The
 *        Blockchains category is already linked via
 *        ChainHeadingsSummary above, so this branch skips it.
 *    (c) Dimension venue — venue filter values with an explainer, for
 *        benches whose sub-pages are per venue instead of per chain.
 *  Without this the PM cluster sub-pages (pm-api-latency venues,
 *  pm-rate-limits venues, polymarket-resolution-delay categories) shipped
 *  as sitemap orphans with zero incoming anchors. */
function PerChainPagesNav({ benchmark }: { benchmark: Benchmark }) {
  const resultSlugs = new Set(benchmark.results.map((r) => r.slug));
  const explainerEntries = benchmark.perChainExplainer ?? [];
  if (explainerEntries.length === 0) return null;

  const chainOptions = benchmark.dimensions?.chain ?? [];
  const venueOptions = benchmark.dimensions?.venue ?? [];
  const chainBySlug = new Map(chainOptions.map((c) => [c.value, c]));
  const venueBySlug = new Map(venueOptions.map((v) => [v.value, v]));

  const entries: { slug: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const e of explainerEntries) {
    const chainOpt = chainBySlug.get(e.slug);
    if (chainOpt && chainOpt.value.toLowerCase() !== "all") {
      const canonSlug = canonicalChainSlug(chainOpt.value);
      if (seen.has(canonSlug)) continue;
      seen.add(canonSlug);
      entries.push({ slug: canonSlug, label: chainOpt.label });
      continue;
    }
    const venueOpt = venueBySlug.get(e.slug);
    if (venueOpt && venueOpt.value.toLowerCase() !== "all") {
      if (seen.has(venueOpt.value)) continue;
      seen.add(venueOpt.value);
      entries.push({ slug: venueOpt.value, label: venueOpt.label });
      continue;
    }
    if (resultSlugs.has(e.slug) && benchmark.category !== "Blockchains") {
      if (seen.has(e.slug)) continue;
      seen.add(e.slug);
      const row = benchmark.results.find((r) => r.slug === e.slug);
      entries.push({ slug: e.slug, label: row?.name ?? e.slug });
    }
  }
  if (entries.length === 0) return null;
  return (
    <nav className="mt-12 max-w-3xl" aria-label="Per breakdown pages">
      <h2 className="label-mono text-ink-muted">In-depth breakdowns</h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {entries.map((e) => (
          <li key={e.slug}>
            <Link
              href={`/benchmarks/${benchmark.slug}/${e.slug}`}
              className="inline-block rounded-md card-soft px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
            >
              {e.label}
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
