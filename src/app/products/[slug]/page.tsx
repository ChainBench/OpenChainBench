import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { getProvider } from "@/lib/providers";
import { CHAIN_BY_SLUG } from "@/lib/chains";
import { ProviderLogo } from "@/components/provider-logo";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import { fmtUnit } from "@/lib/format";
import { capDescription } from "@/lib/seo-text";
import { SITE } from "@/data/site";
import {
  getProviderRegistry,
  PROVIDER_REGISTRY,
} from "@/data/provider-registry";
import { Breadcrumb } from "@/components/breadcrumb";
import { buildBreadcrumbJsonLd, safeJsonLd } from "@/lib/jsonld";
import {
  fetchHlBuilderStats,
  isHlBuilderWithHistory,
} from "@/lib/hl-builder-stats";
import { HlBuilderDashboard } from "@/components/hl-builder-dashboard";
import { RelatedProvidersSection } from "@/components/related-providers-section";
import { getPmVenueContext } from "@/lib/pm-venue-context";
import { fetchPmDataFeedKpis } from "@/lib/pm-venue-data";
import { fetchPerpVenueKpis } from "@/lib/perp-venue-data";
import { hasRpcProviderData } from "@/lib/rpc-hub-stats";
import { PmVenueSection } from "@/components/pm-venue-section";
import {
  getPerpVenueContext,
  PERP_PRODUCT_PILL_SLUGS,
} from "@/lib/perp-venue-context";
import { PerpVenueSection } from "@/components/perp-venue-section";
import { VenueKpiToggle } from "@/components/venue-kpi-toggle";
import { PmDataFeedSection } from "@/components/pm-data-feed-section";
import { RpcProviderChainsSection } from "@/components/rpc-provider-chains-section";

export const revalidate = 60;

// On-demand first render loads every bench (provider profile spans the
// whole catalog). 60s default killed cold renders and ISR regenerations
// mid-flight, freezing stale caches (observed on /benchmarks 2026-06-11:
// "Vercel Runtime Timeout Error: Task timed out after 60 seconds" on
// every regeneration, page stuck on build-time data for hours).
export const maxDuration = 300;

type Params = { slug: string };

// Rendered ON DEMAND (first request, then ISR-cached). Prerendering the
// ~200 product pages at build forced every build worker through the full
// multi-bench Prom load and blew the per-page budget once the HL bench
// grew past 60 providers (observed 2026-06-11: builds failing on
// /products/<slug> after 240s). The empty params list keeps the route
// statically optimized; dynamicParams (default true) renders each slug
// on first hit, and the OG image route follows the same behavior.
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  // Tracked Hyperliquid frontends live under /hyperliquid/<slug> now. The
  // page component 308-redirects, but generateMetadata runs first for the
  // <head> injection — return the canonical + redirect-safe metadata so
  // crawlers that peek at the response before the 308 fires still see the
  // right canonical target.
  // Merkle rebranded to Blink Labs and went keyed-only; the provider was
  // fully delisted 2026-07-10 from the keyless RPC benches; bench 074
  // (mev-protect-rpc) lists them under the new name, so the old URL's
  // link equity lands on the successor product page.
  if (slug === "merkle") {
    permanentRedirect("/products/blinklabs");
  }
  if (await isHlBuilderWithHistory(slug)) {
    const canonicalUrl = `${SITE.url}/hyperliquid/${slug}`;
    return {
      alternates: { canonical: canonicalUrl },
    };
  }
  const p = await getProvider(slug);
  if (!p) return {};
  const reg = getProviderRegistry(p.slug);

  // Meta title carries the head-term shape people search for when
  // evaluating a provider. Format leads with the provider name + head-term
  // "Benchmark" + current year (LLM extractability signal — dated content
  // is cited more by ChatGPT/Perplexity/Copilot). Kept short so Google's
  // ~60-char SERP truncation never cuts the brand suffix that Next's
  // title template appends (" · OpenChainBench").
  const currentYear = new Date().getUTCFullYear();
  const title = `${p.name} Live Benchmark ${currentYear}`;

  // Description prefers the registry's curated one-liner, then falls back
  // to a numeric one summarizing competitive footprint. Either way the
  // first word is the provider name, which is what the SERP snippet keeps
  // when it truncates.
  const benchCount = p.appearances.length;
  const benchWord = benchCount === 1 ? "benchmark" : "benchmarks";
  const winWord = p.wins === 1 ? "first-place finish" : "first-place finishes";
  const winSuffix = p.wins > 0 ? `, ${p.wins} ${winWord}` : "";
  const fallbackDescription = `${p.name} reviewed across ${benchCount} live OpenChainBench ${benchWord}${winSuffix}. Reproducible measurements, open methodology, refreshed every minute.`;
  // Registry descriptions use markdown-flavour backticks for host names
  // and code snippets (rendered as <code> in the product page body).
  // Those leak into meta description and social previews as raw backticks
  // — Google treats them as garbage characters. Strip inline code, bold,
  // and italic markers before injecting into meta.
  const stripInlineMarkdown = (s: string) =>
    s
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1");
  // Some registry descriptions end with a period, others do not. Normalize
  // before appending so the concatenated meta description never reads
  // "...provider Live performance..." as a run-on sentence.
  const rawDescription = reg?.description
    ? `${stripInlineMarkdown(reg.description).replace(/[.!?]?$/, ".")} Live performance across ${benchCount} OpenChainBench ${benchWord}${winSuffix}.`
    : fallbackDescription;
  // Google truncates meta description at ~155 chars in the SERP snippet.
  // Reserve ~22 chars for the ISO date suffix so the concatenated string
  // stays inside the cap even after appending "As of YYYY-MM-DD."
  // (LLM extractability: dated content is cited more by ChatGPT /
  // Perplexity / Copilot, which drive most of our Bing query traffic).
  const isoDate = new Date().toISOString().split("T")[0];
  const description = `${capDescription(rawDescription, 130)} As of ${isoDate}.`;

  // When the resolved provider slug is actually a chain (e.g. /products/eth-usd
  // aliases to /products/ethereum which 308s to /chains/ethereum), point
  // canonical straight to the final 200 surface. Otherwise Ahrefs + GSC
  // flag "canonical points to redirect" and Google may split rank between
  // source + final instead of consolidating.
  const isChain = CHAIN_BY_SLUG.has(p.slug);
  const canonicalUrl = isChain
    ? `${SITE.url}/chains/${p.slug}`
    : `${SITE.url}/products/${p.slug}`;
  return {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: { title, description, type: "profile", url: canonicalUrl },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function ProviderPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  // Merkle rebranded to Blink Labs; 308 to the successor product page.
  // Duplicated from generateMetadata on purpose: the page component is
  // the one whose result gets ISR-cached, and metadata-only redirects
  // left a cached 404 behind (seen live 2026-07-11).
  if (slug === "merkle") {
    permanentRedirect("/products/blinklabs");
  }
  // /hyperliquid/<slug> is the canonical detail surface for tracked HL
  // frontends (12-month focus chart + peer group + KPI strip). Redirect
  // /products/<hl-slug> straight there so backlinks + old SERP entries
  // land on the richer hub without splitting rank signal across two URLs.
  if (await isHlBuilderWithHistory(slug)) {
    // 308, not 307: this is a permanent migration. A temporary
    // redirect tells Google to keep the old /products URL indexed and
    // re-crawl it forever without transferring signals — Ahrefs showed
    // all 95 HL product URLs stuck in "indexable became non-indexable"
    // limbo under the 307 (2026-07-08).
    permanentRedirect(`/hyperliquid/${slug}`);
  }
  const p = await getProvider(slug);
  if (!p) notFound();
  const reg = getProviderRegistry(p.slug);

  // Degraded-read tripwire: a provider listed on several benches never
  // loses EVERY rank in the same cycle — that signature means the store
  // read failed mid-render (srh timeout, snapshot swap), not that data
  // is warming up. Throwing here makes the ISR revalidation fail, so
  // Vercel keeps serving the last good render instead of caching a page
  // full of "data warming up" for the next 5 minutes.
  if (p.appearances.length >= 3 && p.appearances.every((a) => a.rank === 0)) {
    throw new Error(`degraded store read for /products/${slug}: ${p.appearances.length} appearances, all unranked`);
  }

  // HyperTracker-parity dashboard for the 104 Hyperliquid frontends. The
  // strip renders inline between the product header and the bench
  // appearances list, only when the slug actually maps to a builder the
  // on-node harness has data for. Cheap (6 Prom scalars in parallel) and
  // gracefully degrades to a hidden section when Prom is unreachable or
  // the slug isn't an HL builder.
  const isHlBuilder = await isHlBuilderWithHistory(p.slug);
  const hlStats = isHlBuilder ? await fetchHlBuilderStats(p.slug) : null;

  // Prediction-market deep-dive: if the slug is a tracked PM venue or
  // data feed, getPmVenueContext returns the per-venue / per-feed
  // section payload. Returns null for everything else, so non-PM pages
  // pay one cached fetch and render nothing.
  const pmContext = await getPmVenueContext(p.slug);

  // Perp DEX cohort dashboard. Same pattern as the PM context above.
  const perpContext = await getPerpVenueContext(p.slug);

  // KPI-domain availability, resolved upfront so the pill bar knows
  // every domain before rendering. A pill must never open onto an empty
  // section, so each check mirrors the section's own hide-if-empty
  // rule. The KPI fetchers are the same unstable_cache entries the
  // sections read, so none of this costs an extra roundtrip:
  //  - perp: PerpVenueSection nulls when no KPI feed AND no measured row
  //  - PM feed: PmDataFeedSection, same rule
  //  - RPC: hasRpcProviderData reads the cached rpc-hub snapshot and
  //    matches RpcProviderChainsSection's own row filter
  const perpHasData = perpContext
    ? perpContext.benchRows.some((r) => r.value !== null && r.rank !== null) ||
      (await fetchPerpVenueKpis(perpContext.cohortSlug)) !== null
    : false;
  const pmFeedHasData =
    pmContext?.kind === "feed"
      ? pmContext.benchRows.some((r) => r.value !== null && r.rank !== null) ||
        (await fetchPmDataFeedKpis(pmContext.slug)) !== null
      : false;
  const hasRpcData = await hasRpcProviderData(p.slug);

  const sorted = [...p.appearances].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.benchmark.title.localeCompare(b.benchmark.title);
  });

  // Data-driven prose summary of the provider's OCB standing. Replaces the
  // identical templated intro paragraph that used to sit above the fold
  // and made every /products/* page look near-duplicate to Bing (SEO audit
  // 2026-07-05: only 2 of ~5000 pages indexed). Each sentence is derived
  // from live measurements — no editorial claim.
  const rankedAppearances = sorted.filter(
    (a) => a.rank > 0 && a.result.ms.p50 !== 0,
  );
  const topLines: string[] = [];
  for (const a of rankedAppearances.slice(0, 4)) {
    const p50Str = fmtUnit(a.result.ms.p50, a.benchmark.unit);
    const rankStr = a.rank === 1 ? "ranks #1" : `ranks #${a.rank} of ${a.totalRanked}`;
    topLines.push(`${a.benchmark.title} (${rankStr}, ${p50Str} p50)`);
  }
  const proseParts: string[] = [];
  if (topLines.length > 0) {
    proseParts.push(
      `${p.name} ${topLines.length === 1 ? "is measured on" : "is measured across"} ${p.appearances.length} live OpenChainBench ${p.appearances.length === 1 ? "benchmark" : "benchmarks"}${p.wins > 0 ? `, with ${p.wins} #1 ${p.wins === 1 ? "finish" : "finishes"}` : ""}:`,
    );
    proseParts.push(`${topLines.join(", ")}.`);
  } else {
    proseParts.push(
      `${p.name} performance benchmarks, live across ${p.appearances.length} ${p.appearances.length === 1 ? "category" : "categories"}. Reproducible measurements, open methodology.`,
    );
  }
  const productProse = proseParts.join(" ");

  // Embeddable badge cards. Scope rules, most exact source first:
  //
  // 1. Benches with a `rank_matrix_query` AND region dimensions use the
  //    exact per-cell rankings (chain × region). The per-chain ranks the
  //    legacy path relies on are cross-region averages: a provider that
  //    only wins from Singapore (dRPC) still reads as the chain leader
  //    because one fast region drags the mean down. Cells fix that:
  //      - leads EVERY cell → one unscoped global badge.
  //      - leads a full chain row (all regions) → one "on <chain>" badge.
  //      - leads a full region column (all chains) → one "from <region>"
  //        badge (skipped when its cells are already claimed by rows).
  //      - leftover isolated cells → "on <chain> from <region>" badges.
  // 2. Benches with chain dimensions but no cell data keep the per-chain
  //    logic: global badge only for a true cross-chain leader, otherwise
  //    one badge per chain led.
  // 3. Benches without dimensions: one global badge per aggregate #1.
  type BadgeCard = {
    key: string;
    title: string;
    chain?: { value: string; label: string };
    region?: { value: string; label: string };
    benchSlug: string;
    providerSlug: string;
  };
  const badgeCards: BadgeCard[] = [];
  for (const a of sorted) {
    const chainDims = (a.benchmark.chainDimensions ?? []).filter(
      (c) => c.value !== "all",
    );
    const regionDims = (a.benchmark.regionDimensions ?? []).filter(
      (r) => r.value !== "all",
    );
    const cellRanks = a.benchmark.cellRanks;
    const me = a.result.slug.toLowerCase();
    const benchSlug = a.benchmark.slug;
    const title = a.benchmark.title;
    // The bench knows the provider under its raw slug (e.g.
    // "publicnode-feehistory" on gas-estimation, "matic-usd" on
    // oracle-deviation), while `p.slug` is the canonical product slug
    // from the URL (publicnode, polygon). The badge route is keyed by
    // the raw slug, so use that for badge URLs to avoid 404s.
    const providerSlug = a.result.slug;

    let handledByCells = false;
    if (cellRanks && regionDims.length > 0) {
      const finestKeys = Object.keys(cellRanks).filter((k) => {
        const [c, r] = k.split("|");
        const chainOk = chainDims.length > 0 ? c !== "all" : c === "all";
        return chainOk && r !== "all";
      });
      if (finestKeys.length > 0) {
        handledByCells = true;
        const wonKeys = new Set(
          finestKeys.filter(
            (k) => cellRanks[k][0]?.slug.toLowerCase() === me,
          ),
        );
        // Collapsed claims require FULL declared coverage, not just the
        // cells that happen to have data this cycle. Without this, a
        // degraded matrix (one surviving cell) would mint an unscoped
        // global "#1" from a single win.
        const expectedCells =
          Math.max(chainDims.length, 1) * regionDims.length;
        if (
          wonKeys.size === finestKeys.length &&
          finestKeys.length === expectedCells
        ) {
          badgeCards.push({ key: benchSlug, title, benchSlug, providerSlug });
          continue;
        }
        if (wonKeys.size === 0) continue;
        const chainOf = (k: string) => k.split("|")[0];
        const regionOf = (k: string) => k.split("|")[1];
        const covered = new Set<string>();
        for (const c of chainDims) {
          const row = finestKeys.filter((k) => chainOf(k) === c.value);
          // Row collapse only when every DECLARED region reported a cell
          // for this chain and the provider won them all.
          if (row.length !== regionDims.length || !row.every((k) => wonKeys.has(k))) continue;
          badgeCards.push({
            key: `${benchSlug}-${c.value}`,
            title,
            chain: c,
            benchSlug,
            providerSlug,
          });
          for (const k of row) covered.add(k);
        }
        for (const r of regionDims) {
          const col = finestKeys.filter((k) => regionOf(k) === r.value);
          const expectedCols = Math.max(chainDims.length, 1);
          if (col.length !== expectedCols || !col.every((k) => wonKeys.has(k))) continue;
          if (col.every((k) => covered.has(k))) continue;
          badgeCards.push({
            key: `${benchSlug}-r-${r.value}`,
            title,
            region: r,
            benchSlug,
            providerSlug,
          });
          for (const k of col) covered.add(k);
        }
        for (const k of wonKeys) {
          if (covered.has(k)) continue;
          const chain = chainDims.find((c) => c.value === chainOf(k));
          const region = regionDims.find((r) => r.value === regionOf(k));
          if (!region) continue;
          badgeCards.push({
            key: `${benchSlug}-${chainOf(k)}-${regionOf(k)}`,
            title,
            ...(chain ? { chain } : {}),
            region,
            benchSlug,
            providerSlug,
          });
        }
        continue;
      }
    }
    if (handledByCells) continue;

    const perChain = a.rankPerChain ?? {};
    const wonChains = chainDims.filter((c) => perChain[c.value]?.rank === 1);
    const isGlobalNumberOne = a.rank === 1;
    if (chainDims.length === 0) {
      if (isGlobalNumberOne) {
        badgeCards.push({ key: benchSlug, title, benchSlug, providerSlug });
      }
      continue;
    }
    const leadsAllChains =
      chainDims.length > 0 && wonChains.length === chainDims.length;
    if (isGlobalNumberOne && leadsAllChains) {
      badgeCards.push({ key: benchSlug, title, benchSlug, providerSlug });
      continue;
    }
    for (const c of wonChains) {
      badgeCards.push({
        key: `${benchSlug}-${c.value}`,
        title,
        chain: c,
        benchSlug,
        providerSlug,
      });
    }
  }

  const url = `${SITE.url}/products/${p.slug}`;
  const sameAs: string[] = [];
  if (reg?.url) sameAs.push(reg.url);
  if (reg?.twitter) {
    sameAs.push(`https://x.com/${reg.twitter.replace(/^@/, "")}`);
  }
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: p.name,
        url: reg?.url ?? url,
        identifier: p.slug,
        description: capDescription(
          reg?.description ??
            `Crypto-infrastructure provider tracked by OpenChainBench across ${p.appearances.length} live benchmarks.`,
          990,
        ),
        ...(sameAs.length > 0 ? { sameAs } : {}),
        subjectOf: sorted.map((a) => ({
          "@type": "Dataset",
          name: a.benchmark.title,
          description: capDescription(a.benchmark.subtitle, 990),
          url: `${SITE.url}/benchmarks/${a.benchmark.slug}`,
          creator: { "@id": `${SITE.url}/#org` },
          license: "https://creativecommons.org/licenses/by/4.0/",
        })),
      },
      // NB: previously emitted a SoftwareApplication node here, but Google's
      // rich result validator rejects it without `offers` and either
      // `aggregateRating` or `review` (Ahref flagged 220+ product pages).
      // We don't sell or rate the products we track — the honest schema is
      // the Organization above plus the Dataset references it links to via
      // `subjectOf`. Removing SoftwareApplication drops the failed rich
      // result attempt without losing any real signal.
      buildBreadcrumbJsonLd([
        { name: "Home", item: SITE.url },
        { name: "Products", item: `${SITE.url}/products` },
        { name: p.name, item: url },
      ]),
    ],
  };

  return (
    <article className="mx-auto max-w-5xl px-6 pt-10 sm:pt-14 pb-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />

      {/* Visible breadcrumb trail - mirrors the BreadcrumbList JSON-LD above. */}
      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: "Products", href: "/products" },
          { label: p.name },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/products"
          className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          All products
        </Link>
      </div>

      {(() => {
        // Brand-family cross-link: surface a "Part of <parent>" badge when
        // this entry is a sub-product, and a "Related products" list on
        // the parent page enumerating its declared children. Computed
        // once near the header so the JSX below only renders if non-empty.
        const parentSlug = reg?.parent;
        const parentReg = parentSlug ? getProviderRegistry(parentSlug) : undefined;
        const children = Object.entries(PROVIDER_REGISTRY)
          .filter(([childSlug, e]) => e.parent === p.slug && childSlug !== p.slug)
          .map(([childSlug, e]) => ({ slug: childSlug, name: e.description.split(".")[0] || childSlug }));
        return (
          <>
            <header className="mt-6 flex items-center gap-4 border-b-2 border-ink pb-6">
              <ProviderLogo slug={p.slug} name={p.name} size={56} />
              <div className="min-w-0">
                <h1 className="display text-2xl sm:text-3xl md:text-4xl tracking-tight">
                  {p.name} <span className="text-ink-soft font-normal">Benchmark</span>
                </h1>
                <p className="mt-1 text-base text-ink-soft">
                  {productProse}
                </p>
                <p className="mt-2 font-sans text-[11px] uppercase tracking-[0.18em] text-ink-muted font-medium">
                  {p.appearances.length} {p.appearances.length === 1 ? "benchmark" : "benchmarks"}
                  {p.wins > 0 && (
                    <>
                      <span className="text-ink-faint"> · </span>
                      <span className="text-good">{p.wins} #1 {p.wins === 1 ? "finish" : "finishes"}</span>
                    </>
                  )}
                  {p.type && (
                    <>
                      <span className="text-ink-faint"> · </span>
                      <span>{p.type}</span>
                    </>
                  )}
                  {parentSlug && parentReg && (
                    <>
                      <span className="text-ink-faint"> · </span>
                      <Link
                        href={`/products/${parentSlug}`}
                        className="hover:text-ink transition-colors underline underline-offset-2 decoration-rule"
                      >
                        Part of {parentSlug}
                      </Link>
                    </>
                  )}
                  {/* Prediction-markets hub pill. Surfaces a one-click
                      jump from a venue/data provider product page to the
                      PM coverage hub. Hard-coded slug list, same shape
                      as the HL companion treatment elsewhere. */}
                  {(
                    p.slug === "polymarket" ||
                    p.slug === "kalshi" ||
                    p.slug === "limitless" ||
                    p.slug === "manifold" ||
                    p.slug === "myriad" ||
                    p.slug === "mobula" ||
                    p.slug === "codex" ||
                    p.slug === "predexon"
                  ) && (
                    <>
                      <span className="text-ink-faint"> · </span>
                      <Link
                        href="/prediction-markets"
                        className="hover:text-ink transition-colors underline underline-offset-2 decoration-rule"
                      >
                        View on /prediction-markets
                      </Link>
                    </>
                  )}
                  {/* Perpetuals hub pill. Same shape as the PM pill,
                      driven by PERP_PRODUCT_PILL_SLUGS in
                      lib/perp-venue-context. */}
                  {PERP_PRODUCT_PILL_SLUGS.has(p.slug) && (
                    <>
                      <span className="text-ink-faint"> · </span>
                      <Link
                        href="/perps"
                        className="hover:text-ink transition-colors underline underline-offset-2 decoration-rule"
                      >
                        View on /perps
                      </Link>
                    </>
                  )}
                </p>
              </div>
            </header>
            {children.length > 0 && (
              <p className="mt-6 text-sm text-ink-muted">
                Related {p.name} products:{" "}
                {children.map((c, i) => (
                  <span key={c.slug}>
                    {i > 0 && <span className="text-ink-faint"> · </span>}
                    <Link href={`/products/${c.slug}`} className="lnk">
                      {c.slug}
                    </Link>
                  </span>
                ))}
              </p>
            )}
          </>
        );
      })()}

      {(() => {
        // KPI domain sections. A product can belong to up to five KPI
        // domains (perp venue, PM venue, PM data feed, HL builder, RPC
        // provider). Every domain with data joins ONE pill bar so all
        // stay reachable on the same page; the bar renders even for a
        // single domain so the section is always labeled with its KPI
        // family. Availability is resolved before render:
        // perpContext / pmContext / hlStats above, hasRpcData for the
        // rpc-hub snapshot.
        const sections: { id: string; label: string; content: React.ReactNode }[] = [];
        if (perpContext && perpHasData) {
          sections.push({
            id: "perp",
            label: "Perpetuals",
            content: (
              <PerpVenueSection
                slug={perpContext.slug}
                cohortSlug={perpContext.cohortSlug}
                name={perpContext.name}
                chainLabel={perpContext.chainLabel}
                externalUrl={perpContext.externalUrl}
                benchRows={perpContext.benchRows}
              />
            ),
          });
        }
        if (pmContext?.kind === "venue") {
          sections.push({
            id: "pm",
            label: "Prediction markets",
            content: (
              <PmVenueSection
                slug={pmContext.slug}
                name={pmContext.name}
                chainLabel={pmContext.chainLabel}
                externalUrl={pmContext.externalUrl}
                venueType={pmContext.venueType}
                benchRows={pmContext.benchRows}
              />
            ),
          });
        }
        if (pmContext?.kind === "feed" && pmFeedHasData) {
          sections.push({
            id: "pm-feed",
            label: "Data feeds",
            content: (
              <PmDataFeedSection
                slug={pmContext.slug}
                name={pmContext.name}
                logoSrc={pmContext.logoSrc}
                externalUrl={pmContext.externalUrl}
                benchRows={pmContext.benchRows}
              />
            ),
          });
        }
        if (hlStats) {
          sections.push({
            id: "hl",
            label: "Hyperliquid",
            content: <HlBuilderDashboard stats={hlStats} name={p.name} />,
          });
        }
        if (hasRpcData) {
          sections.push({
            id: "rpc",
            label: "RPC",
            content: (
              <RpcProviderChainsSection
                providerSlug={p.slug}
                providerName={p.name}
              />
            ),
          });
        }
        return <VenueKpiToggle sections={sections} />;
      })()}

      {reg && (
        <section className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-8">
          <p className="text-base text-ink-soft leading-relaxed max-w-2xl">
            {reg.description}
          </p>
          <ul className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-4 sm:gap-y-1 sm:ml-auto sm:flex-col sm:items-end sm:text-right shrink-0 min-w-0">
            <li className="min-w-0">
              <a
                className="lnk inline-flex items-center gap-1 font-sans text-[11px] uppercase tracking-[0.16em] font-medium text-ink-soft hover:text-ink break-all"
                href={reg.url}
                rel="noopener"
              >
                {reg.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                <ArrowUpRight size={11} strokeWidth={2} className="shrink-0" />
              </a>
            </li>
            {reg.twitter && (
              <li>
                <a
                  className="lnk inline-flex items-center gap-1 font-sans text-[11px] uppercase tracking-[0.16em] font-medium text-ink-soft hover:text-ink"
                  href={`https://x.com/${reg.twitter.replace(/^@/, "")}`}
                  rel="noopener"
                >
                  {reg.twitter}
                  <ArrowUpRight size={11} strokeWidth={2} />
                </a>
              </li>
            )}
          </ul>
        </section>
      )}

      {(() => {
        // Most recent lastRunAt across every appearance is the truest
        // "last measured" signal a Google freshness ranker, an AI citation
        // engine or a researcher can pin on. Rendered as a visible <time>
        // element so the page exposes its data freshness above the fold
        // on the leaderboard.
        const latest = sorted.reduce<string | null>((acc, a) => {
          const t = a.benchmark.lastRunAt;
          if (!t) return acc;
          if (!acc || new Date(t) > new Date(acc)) return t;
          return acc;
        }, null);
        if (!latest) return null;
        const d = new Date(latest);
        return (
          <p className="mt-8 font-sans text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Last measured{" "}
            <time dateTime={d.toISOString()} className="text-ink-soft">
              {d.toUTCString().replace("GMT", "UTC")}
            </time>
          </p>
        );
      })()}

      <section className="mt-6">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          Live benchmark results
        </h2>
        <ol className="mt-4 divide-y divide-rule border-y border-rule">
          {sorted.map((a) => {
            const catColor = CATEGORY_COLOR[a.benchmark.category];
            const hasData = a.rank > 0 && a.result.ms.p50 !== 0;
            const value = hasData ? fmtUnit(a.result.ms.p50, a.benchmark.unit) : null;
            // Per-chain rank chips. Rendered alongside the aggregate rank
            // when the bench declares chain dimensions and the provider has
            // per-chain ranks populated. Surface text reads e.g. "#1 on
            // Solana · #4 on Base · #4 on BNB" so a chain-restricted
            // provider can't be passed off as a free cross-chain #1.
            const chainRanks =
              a.rankPerChain && a.benchmark.chainDimensions
                ? a.benchmark.chainDimensions
                    .filter((c) => c.value !== "all")
                    .map((c) => ({ chain: c, entry: a.rankPerChain?.[c.value] }))
                    .filter(
                      (
                        x,
                      ): x is {
                        chain: { value: string; label: string };
                        entry: { rank: number; totalRanked: number };
                      } => !!x.entry,
                    )
                : [];
            const hasChainRanks = chainRanks.length > 0;
            return (
              <li key={a.benchmark.slug}>
                <Link
                  href={`/benchmarks/${a.benchmark.slug}`}
                  className="group grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto] items-start sm:items-center gap-x-4 gap-y-2 py-5 pl-3 pr-3 hover:bg-paper-soft/60 transition-colors"
                >
                  <span
                    className="font-sans tabular text-xl sm:text-2xl font-semibold w-12 text-center"
                    style={{ color: a.rank === 1 ? "var(--color-good)" : "var(--color-ink-soft)" }}
                  >
                    {hasData ? (
                      <>
                        #{a.rank}
                        <span className="block text-[9px] uppercase tracking-[0.16em] text-ink-faint mt-0.5">
                          of {a.totalRanked}
                        </span>
                      </>
                    ) : (
                      <span className="block text-[10px] uppercase tracking-[0.16em] text-ink-faint italic font-normal">
                        awaiting
                      </span>
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="font-sans text-[10px] uppercase tracking-[0.18em] font-medium" style={{ color: catColor ?? "var(--color-ink-faint)" }}>
                      {a.benchmark.category}
                    </p>
                    <h3 className="mt-0.5 display text-base sm:text-lg font-semibold leading-tight truncate">
                      {a.benchmark.title}
                    </h3>
                    <p className="text-xs text-ink-muted truncate">
                      {a.benchmark.metric}
                    </p>
                    {hasChainRanks && (
                      <p className="mt-1.5 flex flex-wrap items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.14em] font-medium">
                        {chainRanks.map(({ chain, entry }) => (
                          <span
                            key={chain.value}
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                              entry.rank === 1
                                ? "border-good/40 bg-good/10 text-good"
                                : "border-rule bg-paper-soft text-ink-muted"
                            }`}
                          >
                            #{entry.rank} on {chain.label}
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                  <div className="col-start-2 sm:col-start-3 text-left sm:text-right">
                    {hasData ? (
                      <>
                        <p className="font-sans tabular text-base text-ink">{value}</p>
                        <p className="font-sans text-[9px] uppercase tracking-[0.16em] text-ink-faint mt-0.5 font-medium">
                          p50 · 24h
                        </p>
                      </>
                    ) : (
                      <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint italic font-medium">
                        data warming up
                      </p>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      </section>

      <RelatedProvidersSection providerSlug={p.slug} providerName={p.name} />

      {badgeCards.length > 0 && (
        <section className="mt-12">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
            Embeddable badges
          </h2>
          <p className="mt-2 text-sm text-ink-soft leading-snug max-w-2xl">
            Drop these on your site to show your standing on a benchmark.
            The SVG fetches the latest figures on every request, so the badge
            stays accurate without redeploying.
          </p>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {badgeCards.map((card) => {
              // Absolute URL is the one shipped to embedders (it has to
              // work from any third-party origin), but the in-page preview
              // <img> uses a relative path so it loads under the current
              // origin's CSP (`img-src 'self'`). Without this, the preview
              // shows the browser's broken-image glyph on every non-prod
              // origin (staging Preview URLs, Vercel branch previews, etc.)
              // because the CSP refuses the cross-origin fetch.
              const scopeParams = new URLSearchParams();
              if (card.chain) scopeParams.set("chain", card.chain.value);
              if (card.region) scopeParams.set("region", card.region.value);
              const qs = scopeParams.size > 0 ? `?${scopeParams.toString()}` : "";
              const badgePath = `/api/badge/${card.benchSlug}/${card.providerSlug}${qs}`;
              const badgeUrl = `${SITE.url}${badgePath}`;
              const targetUrl = `${SITE.url}/benchmarks/${card.benchSlug}${qs}`;
              const scopeSuffix = `${card.chain ? ` on ${card.chain.label}` : ""}${card.region ? ` from ${card.region.label}` : ""}`;
              const scopeLabels = [card.chain?.label, card.region?.label]
                .filter(Boolean)
                .join(" · ");
              const cardTitle = scopeLabels
                ? `${card.title} · ${scopeLabels}`
                : card.title;
              const altText = `Ranked #1 on OpenChainBench: ${card.title}${scopeSuffix}`;
              const html = `<a href="${targetUrl}"><img src="${badgeUrl}" alt="${altText}" height="44" /></a>`;
              const markdown = `[![${altText}](${badgeUrl})](${targetUrl})`;
              // Pre-baked X intent. Providers click → tweet draft opens
              // with the ranking claim, the bench URL and the OCB handle
              // already filled in. Removes the friction of writing the
              // post themselves and gives us the canonical anchor text
              // back as a tagged tweet on every share.
              const tweetText = `Independently benchmarked #1 on ${card.title}${scopeSuffix} by @OpenChainBench.\n\nReproducible methodology, live data:`;
              const tweetIntent = `https://x.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent(targetUrl)}`;
              return (
                <li key={`badge-${card.key}`} className="card-soft p-4">
                  <p className="text-xs font-sans font-medium uppercase tracking-[0.18em] text-ink-muted">
                    {cardTitle}
                  </p>
                  <div className="mt-3 flex items-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={badgePath}
                      alt={altText}
                      height={44}
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] font-sans font-medium uppercase tracking-[0.18em] text-ink-muted">
                    {/* Hide the Share on X CTA on /products/mobula. OCB
                        is built by Mobula, so a pre-filled tweet praising
                        Mobula posted from a visitor account reads as a
                        self-promo loop. Every other provider keeps the
                        share link. */}
                    {p.slug !== "mobula" && (
                      <a
                        href={tweetIntent}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center gap-1 hover:text-ink"
                      >
                        Share on X
                        <ArrowUpRight size={11} strokeWidth={2} />
                      </a>
                    )}
                  </div>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[11px] font-sans font-medium uppercase tracking-[0.18em] text-ink-muted hover:text-ink">
                      Copy HTML
                    </summary>
                    <pre className="mt-2 overflow-x-auto rounded border border-rule bg-paper-soft p-2 text-[11px] leading-snug">
{html}
                    </pre>
                  </details>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] font-sans font-medium uppercase tracking-[0.18em] text-ink-muted hover:text-ink">
                      Copy Markdown
                    </summary>
                    <pre className="mt-2 overflow-x-auto rounded border border-rule bg-paper-soft p-2 text-[11px] leading-snug">
{markdown}
                    </pre>
                  </details>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p className="mt-12 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
        Raw figures{" "}
        <a className="lnk" href={`${SITE.url}/api/citable`}>
          /api/citable
          <ArrowUpRight size={12} strokeWidth={2} className="inline ml-1" />
        </a>
      </p>
    </article>
  );
}
