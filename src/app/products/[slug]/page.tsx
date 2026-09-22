import type { Metadata } from "next";
import { loadSitemapBlob } from "@/lib/sitemap-blob";
import { isExpiredRpcPage } from "@/lib/provider-filters";
import { notFound, permanentRedirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { getProvider } from "@/lib/providers";
import { CHAIN_BY_SLUG } from "@/lib/chains";
import { ProviderLogo } from "@/components/provider-logo";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import { fmtUnit, valueWindowLabel } from "@/lib/format";
import { capDescription } from "@/lib/seo-text";
import { SITE } from "@/data/site";
import {
  getProviderRegistry,
  PROVIDER_REGISTRY,
} from "@/data/provider-registry";
import { Breadcrumb } from "@/components/breadcrumb";
import { buildBreadcrumbJsonLd, safeJsonLd } from "@/lib/jsonld";
import { CREATOR_PUBLISHER, CITABLE_JSON_URL, DATASET_LICENSE } from "@/lib/dataset-jsonld";
import { getBenchCreatedAt } from "@/lib/seo/bench-dates";
import { isHlBuilderSlug } from "@/lib/hl-builder-stats";
import { HlFrontendSection } from "@/components/hl-frontend-section";
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
import { TradingAppSection } from "@/components/trading-app-section";
import { DataApiProviderSection } from "@/components/data-api-provider-section";
import { BridgeProviderSection } from "@/components/bridge-provider-section";
import { loadTradingAppMatrix, TRADING_APP_SLUGS, TRADING_APP_COLUMNS } from "@/lib/trading-apps";
import { fetchDataApiSnapshot } from "@/lib/data-api-stats";
import { getTradingAppHistory } from "@/lib/trading-app-history";
import { fetchBridgeHub } from "@/lib/bridge-hub-stats";

export const revalidate = 3600;

// On-demand first render loads every bench (provider profile spans the
// whole catalog). 60s default killed cold renders and ISR regenerations
// mid-flight, freezing stale caches (observed on /benchmarks 2026-06-11:
// "Vercel Runtime Timeout Error: Task timed out after 60 seconds" on
// every regeneration, page stuck on build-time data for hours).
// Was 300 while pages queried Prometheus directly; they now read
// pre-materialized blobs (66 KB per bench, aggregate through the CDN,
// cold fetch 18-49 s), so 120 bounds a runaway render without
// starving a legitimately cold one. Provisioned memory is billed for
// the whole wall time, so the cap is a cost control too.
export const maxDuration = 120;

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

/** A row that is a link when the target page is indexable, a div
 *  otherwise (same layout, no anchor into a noindex page). */
function RowLink({
  href,
  className,
  children,
}: {
  href: string | null;
  className: string;
  children: React.ReactNode;
}) {
  return href ? (
    <Link href={href} className={className}>
      {children}
    </Link>
  ) : (
    <div className={className}>{children}</div>
  );
}

const CATEGORY_NOUN: Record<string, string> = {
  Bridges: "bridge",
  Aggregators: "aggregator",
  Blockchains: "chain",
  Trading: "trading",
  Wallets: "wallet",
  RPCs: "RPC",
};

/** "Arbitrum RPC" for a chain RPC bench; the title up to its first comma
 *  or colon otherwise, and "bridge quote latency" (category noun plus
 *  metric) when even that runs long. Full titles are 45 to 65 characters
 *  and ate the whole 158-character snippet before the second value
 *  (audit 2026-09-19, major 3: /products/relay cut mid-sentence). */
function shortBenchLabel(b: { slug: string; title: string; category: string; metric: string }): string {
  const m = b.title.match(/^([A-Za-z0-9 .-]+?) RPC endpoints/i) ?? b.title.match(/free ([A-Za-z0-9 .-]+?) RPC/i);
  if (m && b.slug.endsWith("-rpc")) return `${m[1]} RPC`;
  const head = b.title.split(/[,:]/)[0].trim();
  if (head.length <= 40) return head;
  const noun = CATEGORY_NOUN[b.category] ?? b.category.toLowerCase();
  return `${noun} ${b.metric.toLowerCase()}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  // Merkle rebranded to Blink Labs and went keyed-only; the provider was
  // fully delisted 2026-07-10 from the keyless RPC benches; bench 074
  // (mev-protect-rpc) lists them under the new name, so the old URL's
  // link equity lands on the successor product page.
  if (slug === "merkle") {
    permanentRedirect("/products/blinklabs");
  }
  // Alias → canonical, mirrored in the page component below: a
  // metadata-only redirect leaves a cached 404 behind (merkle, 2026-07-11).
  {
    const resolved = await getProvider(slug);
    if (resolved && resolved.slug.toLowerCase() !== slug.toLowerCase()) {
      permanentRedirect(`/products/${resolved.slug}`);
    }
  }
  // /products/<slug> is the one canonical page per product since
  // 2026-09-17. The former /hyperliquid/<slug> and /perp/<slug> detail
  // routes 308 here (next.config redirects) and their content is a view
  // behind the pill bar below: a product belongs to several categories,
  // so no category may own its page.
  const p = await getProvider(slug);
  if (!p) return {};
  const reg = getProviderRegistry(p.slug);

  // Meta title carries the head-term shape people search for when
  // evaluating a provider. Format leads with the provider name + head-term
  // "Benchmark" + current year (LLM extractability signal — dated content
  // is cited more by ChatGPT/Perplexity/Copilot). Kept short so Google's
  // ~60-char SERP truncation never cuts the brand suffix that Next's
  // title template appends (" · OpenChainBench").
  // Brand queries ("publicnode" 57 impressions at position 8, "leorpc" 49
  // at position 4, 0 clicks each on 2026-09-19) land next to the brand's
  // own site; the title has to say what this page adds, independent
  // measurement, and the description has to carry the numbers.
  const title = `${p.name} benchmark: live rank and measured numbers`;

  // Description prefers the registry's curated one-liner, then falls back
  // to a numeric one summarizing competitive footprint. Either way the
  // first word is the provider name, which is what the SERP snippet keeps
  // when it truncates.
  const benchCount = p.appearances.length;
  const benchWord = benchCount === 1 ? "benchmark" : "benchmarks";
  const winWord = p.wins === 1 ? "first-place finish" : "first-place finishes";
  const winSuffix = p.wins > 0 ? `, ${p.wins} ${winWord}` : "";
  const fallbackDescription = `${p.name} reviewed across ${benchCount} live OpenChainBench ${benchWord}${winSuffix}.`;
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
  // Measured facts first: the best two ranked appearances with rank and
  // value, then the registry one-liner if room remains. The dated
  // "As of" belongs in the page body (TL;DR, JSON-LD dateModified), not
  // in 22 characters of the snippet.
  const metaRanked = [...p.appearances]
    .filter((a) => a.rank > 0 && a.result.ms.p50 !== 0)
    // Tie-break on the size of the field a rank was earned in (#1 of 6
    // before #1 of 2), then the title; the alphabetical break opened
    // PublicNode's snippet with Akash and Arbitrum Nova (audit 2026-09-21).
    .sort((a, b) => a.rank - b.rank || b.totalRanked - a.totalRanked || a.benchmark.title.localeCompare(b.benchmark.title))
    .slice(0, 2)
    // Always the denominator and, on a tier-dimensioned bench, the cohort:
    // "#1 on Arc RPC" read as the page's leader while dRPC leads the public
    // cohort and Alchemy the private one (audit 2026-09-21).
    .map((a) => `#${a.rank} of ${a.totalRanked}${cohortWord(a)} on ${shortBenchLabel(a.benchmark)} at ${fmtUnit(a.result.ms.p50, a.benchmark.unit)}`);
  // Count first, ranks second: the 158-character cap lands inside the
  // rank list on providers with two long bench labels, and a sentence
  // cut on a numeral ("at 4.") is what the snippet then shows (audit
  // 2026-09-22). The count sentence is complete however the cut falls.
  const measuredLead =
    metaRanked.length > 0
      ? `${p.name}: ${benchCount} live ${benchWord}${winSuffix}. Ranks ${metaRanked.join(", ")} (p50, 24h).`
      : fallbackDescription;
  const registryLine = reg?.description
    ? stripInlineMarkdown(reg.description).replace(/[.!?]?$/, ".")
    : "";
  const description = capDescription(`${measuredLead} ${registryLine}`.trim(), 158);

  // When the resolved provider slug is actually a chain (e.g. /products/eth-usd
  // aliases to /products/ethereum which 308s to /chains/ethereum), point
  // canonical straight to the final 200 surface. Otherwise Ahrefs + GSC
  // flag "canonical points to redirect" and Google may split rank between
  // source + final instead of consolidating.
  // Hyperliquid and dYdX are chains AND perp venues with 14-17 benches
  // of their own; their product page (Perpetuals view) is a distinct
  // entity from the chain page and keeps its own canonical.
  const isChain = CHAIN_BY_SLUG.has(p.slug) && !PERP_PRODUCT_PILL_SLUGS.has(p.slug);
  const canonicalUrl = isChain
    ? `${SITE.url}/chains/${p.slug}`
    : `${SITE.url}/products/${p.slug}`;
  // Newest measurement across the provider's appearances: the online
  // date scholarly and answer-engine crawlers read from citation_* meta
  // (the bench pages carry the same set; the product template had none).
  const lastRuns = p.appearances
    .map((a) => Date.parse(a.benchmark.lastRunAt ?? ""))
    .filter((t) => Number.isFinite(t));
  const newestLastRunIso =
    lastRuns.length > 0 ? new Date(Math.max(...lastRuns)).toISOString().slice(0, 10) : null;
  return {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: { title, description, type: "profile", url: canonicalUrl },
    twitter: { card: "summary_large_image", site: SITE.twitter, title, description },
    other: {
      citation_title: title,
      citation_author: "OpenChainBench",
      citation_publisher: "OpenChainBench",
      ...(newestLastRunIso ? { citation_online_date: newestLastRunIso } : {}),
      citation_public_url: canonicalUrl,
      citation_language: "en",
      citation_journal_title: "OpenChainBench",
    },
  };
}

/** " public endpoints" / " private (API-key) providers" for a rank on a
 *  tier-dimensioned bench, "" elsewhere: a rank is always stated within
 *  the cohort it was earned in. */
function cohortWord(a: { tier?: string; benchmark: { slug: string } }): string {
  if (!a.benchmark.slug.endsWith("-rpc")) return "";
  if (a.tier === "keyed") return " private (API-key) providers";
  return " public endpoints";
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
  const p = await getProvider(slug);
  if (!p) notFound();
  // One URL per product. getProvider resolves aliases, so a request for a
  // non-canonical slug would otherwise answer 200 on a second URL; a 308
  // sends the link equity to the canonical one instead. This also closes
  // the /hyperliquid/<slug> and /perp/<slug> rewrites, which 308 here
  // without checking that the slug exists.
  if (p.slug.toLowerCase() !== slug.toLowerCase()) {
    permanentRedirect(`/products/${p.slug}`);
  }
  const reg = getProviderRegistry(p.slug);
  // Bench pages this deployment indexes (worker sitemap minus expired
  // chain pages). An appearance on a thin or expired chain RPC bench is
  // still shown (it is a real measurement) but not linked: the product
  // pages were a main source of crawl into noindex pages (2 to 7 per
  // page on 2026-09-19).
  const sitemapBlob = await loadSitemapBlob();
  const linkableBench = sitemapBlob
    ? new Set(sitemapBlob.benches.filter((b) => !isExpiredRpcPage(b)).map((b) => b.slug))
    : null;
  const canLink = (benchSlug: string) =>
    !benchSlug.endsWith("-rpc") || !linkableBench || linkableBench.has(benchSlug);

  // Degraded-read tripwire: a provider listed on several benches never
  // loses EVERY rank in the same cycle — that signature means the store
  // read failed mid-render (srh timeout, snapshot swap), not that data
  // is warming up. Throwing here makes the ISR revalidation fail, so
  // Vercel keeps serving the last good render instead of caching a page
  // full of "data warming up" for the next 5 minutes.
  //
  // Tightened gate: only fire when EVERY appearance claims availability
  // "live", is not marked unresponsive, AND has a non-zero p50. This
  // captures the true store-read-failure signature (data present but
  // ranking silently failed) while excluding newly-added providers whose
  // store snapshot lags the harness by one aggregate cycle (thirdweb
  // ship 2026-07-24: 4 fresh appearances all rank=0 while the CDN blob
  // still served the pre-ship snapshot with p50=0).
  const allClaimLive = p.appearances.every(
    (a) =>
      a.result.availability === "live" &&
      a.result.unresponsive !== true,
  );
  // A new provider on new benches legitimately has rank=0 everywhere while
  // its endpoints are warming up: low successRate excludes it from the
  // citationCandidates pool even when p50>0. The tripwire should only fire
  // for the genuine store-failure signature: an appearance that WOULD be
  // ranked (live bench, good confidence, successRate≥50%) but has rank=0
  // anyway — which only happens when the ranking pipeline silently failed.
  const anyWouldBeRanked = p.appearances.some(
    (a) =>
      (a.result.ms?.p50 ?? 0) > 0 &&
      a.benchmark.status === "live" &&
      a.result.dataConfidence !== "insufficient" &&
      (a.result.successRate ?? 100) >= 50,
  );
  if (
    p.appearances.length >= 8 &&
    p.appearances.every((a) => a.rank === 0) &&
    allClaimLive &&
    anyWouldBeRanked
  ) {
    throw new Error(`degraded store read for /products/${slug}: ${p.appearances.length} appearances, all unranked`);
  }

  // Hyperliquid frontend view (the former /hyperliquid/<slug> page) for
  // every builder on the hyperliquid-frontends bench. The section itself
  // degrades when Prom or the history blob is unavailable, so membership
  // is the only gate.
  const isHlBuilder = await isHlBuilderSlug(p.slug);

  // Prediction-market deep-dive: if the slug is a tracked PM venue or
  // data feed, getPmVenueContext returns the per-venue / per-feed
  // section payload. Returns null for everything else, so non-PM pages
  // pay one cached fetch and render nothing.
  const pmContext = await getPmVenueContext(p.slug);

  // Perp DEX cohort dashboard. Same pattern as the PM context above.
  // perp-fees-at-size bench was removed; pass null so loadBenchFromBlob
  // (cache: "no-store") is not called from an ISR page (it would trigger
  // Next.js "Page changed from static to dynamic" for polymarket).
  const perpContext = await getPerpVenueContext(p.slug, null);

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
  // Trading app / data API / bridge views: same hide-if-empty rule, each
  // check reads the cached snapshot its section reads.
  const tradingAppHasData =
    (await getTradingAppHistory().then((h) => !!h?.apps.some((a) => a.slug === p.slug))) ||
    (TRADING_APP_SLUGS.has(p.slug)
      ? await loadTradingAppMatrix().then((m) => {
          const me = m.rows.find((r) => r.slug === p.slug);
          return !!me && TRADING_APP_COLUMNS.some((c) => me.values[c.key] !== null);
        })
      : false);
  const dataApiHasData = await fetchDataApiSnapshot().then(
    (s) => !!s?.providers.find((r) => r.slug === p.slug && r.cells.length > 0),
  );
  const bridgeHasData = await fetchBridgeHub().then((h) => {
    const r = h?.providers.find((x) => x.slug === p.slug);
    return !!r && (r.feep50 != null || r.quotep50 != null);
  });

  const sorted = [...p.appearances].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // Larger field first (see metaRanked), then the title.
    if (a.totalRanked !== b.totalRanked) return b.totalRanked - a.totalRanked;
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
    const rankStr = `ranks #${a.rank} of ${a.totalRanked}${cohortWord(a)}`;
    topLines.push(`${shortBenchLabel(a.benchmark)} (${rankStr}, ${p50Str} p50)`);
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
  // Dated, like the bench TL;DR: the newest measurement behind the
  // sentence above, so a quoted line carries its own as-of.
  const proseRuns = p.appearances
    .map((a) => Date.parse(a.benchmark.lastRunAt ?? ""))
    .filter((t) => Number.isFinite(t));
  if (proseRuns.length > 0) {
    proseParts.push(`Data as of ${new Date(Math.max(...proseRuns)).toISOString().slice(0, 10)} UTC.`);
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
    /** Access cohort the rank was earned in (keyed RPC providers). */
    tier?: string;
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
    // cellRanks describe the bench's headline cohort; a tiered appearance
    // (keyed RPC provider) is ranked within its cohort below instead.
    if (cellRanks && regionDims.length > 0 && !a.tier) {
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
        badgeCards.push({
          key: a.tier ? `${benchSlug}-t-${a.tier}` : benchSlug,
          title,
          ...(a.tier ? { tier: a.tier } : {}),
          benchSlug,
          providerSlug,
        });
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
        // Only indexable bench pages: a Dataset node pointing at a noindex
        // URL is a crawl hint into a page we asked engines to skip.
        subjectOf: sorted.filter((a) => canLink(a.benchmark.slug)).map((a) => ({
          "@type": "Dataset",
          // GSC + Google Dataset Search flag anonymous Datasets
          // ("Unnamed item" with recommended fields missing) when the
          // @id + datePublished are absent (audit 2026-07-26). Match
          // the shape used by the bench page's own Dataset node so
          // cross-page identifiers align.
          "@id": `${SITE.url}/benchmarks/${a.benchmark.slug}#dataset`,
          name: a.benchmark.title,
          description: capDescription(a.benchmark.subtitle, 990),
          url: `${SITE.url}/benchmarks/${a.benchmark.slug}`,
          identifier: a.benchmark.slug,
          variableMeasured: a.benchmark.metric,
          datePublished: getBenchCreatedAt(a.benchmark.slug).toISOString(),
          creator: CREATOR_PUBLISHER,
          publisher: CREATOR_PUBLISHER,
          isAccessibleForFree: true,
          license: DATASET_LICENSE,
          distribution: [
            {
              "@type": "DataDownload",
              encodingFormat: "application/json",
              contentUrl: `${SITE.url}/api/stat/${a.benchmark.slug}`,
            },
            {
              "@type": "DataDownload",
              encodingFormat: "application/json",
              contentUrl: CITABLE_JSON_URL,
            },
          ],
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
                    p.slug === "myriad"
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
        // Category views. A product can belong to several categories
        // (perp venue, PM venue, PM data feed, Hyperliquid frontend, RPC
        // provider, trading app, data API, bridge); every one with data joins ONE pill bar so all stay
        // reachable on the same page, and the URL hash (#perp, #hl, ...)
        // deep-links a view. The bar renders even for a single view so
        // the section is always labeled with its family. Availability is
        // resolved before render: perpContext / pmContext / isHlBuilder
        // above, hasRpcData for the rpc-hub snapshot.
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
        if (isHlBuilder) {
          sections.push({
            id: "hl",
            label: "Hyperliquid",
            content: <HlFrontendSection slug={p.slug} name={p.name} />,
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
        if (tradingAppHasData) {
          sections.push({
            id: "trading-app",
            label: "Trading app",
            content: <TradingAppSection slug={p.slug} name={p.name} />,
          });
        }
        if (dataApiHasData) {
          sections.push({
            id: "data-api",
            label: "Data API",
            content: <DataApiProviderSection slug={p.slug} name={p.name} />,
          });
        }
        if (bridgeHasData) {
          sections.push({
            id: "bridge",
            label: "Bridge",
            content: <BridgeProviderSection slug={p.slug} name={p.name} />,
          });
        }
        // Pill order: what the product IS first (trading app, perp venue,
        // prediction market, data API, bridge, RPC), the Hyperliquid
        // frontend numbers last. FOMO reads "Trading app | Hyperliquid".
        const ORDER = ["trading-app", "perp", "pm", "pm-feed", "data-api", "bridge", "rpc", "hl"];
        sections.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
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
            // Per-chain leadership chips, rendered alongside the aggregate
            // rank when the bench declares chain dimensions. Leaders only:
            // a chip means "leads this chain", and its absence means "does
            // not lead", never "ranks lower". Reads e.g. "#1 of 4 on
            // Ethereum" so a chain-restricted provider can't be passed off
            // as a free cross-chain #1, and so a win on a two-provider
            // chain isn't dressed up as a win on a crowded one.
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
              <li key={a.tier ? `${a.benchmark.slug}#tier=${a.tier}` : a.benchmark.slug}>
                <RowLink
                  href={
                    canLink(a.benchmark.slug)
                      ? `/benchmarks/${a.benchmark.slug}${a.tier ? `#tier=${a.tier}` : ""}`
                      : null
                  }
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
                      {a.tier ? <> · {a.tier === "keyed" ? "private cohort (API key)" : `${a.tier} cohort`}, ranked separately</> : null}
                    </p>
                    {hasChainRanks && (
                      <p className="mt-1.5 flex flex-wrap items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.14em] font-medium">
                        {chainRanks.map(({ chain, entry }) => (
                          <span
                            key={chain.value}
                            className="inline-flex items-center gap-1 rounded-full border border-good/40 bg-good/10 px-2 py-0.5 text-good"
                          >
                            #1{entry.totalRanked > 0 ? ` of ${entry.totalRanked}` : ""} on{" "}
                            {chain.label}
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
                          {valueWindowLabel(a.benchmark)}
                        </p>
                      </>
                    ) : (
                      <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint italic font-medium">
                        data warming up
                      </p>
                    )}
                  </div>
                </RowLink>
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
              if (card.tier) scopeParams.set("tier", card.tier);
              const qs = scopeParams.size > 0 ? `?${scopeParams.toString()}` : "";
              const badgePath = `/api/badge/${card.benchSlug}/${card.providerSlug}${qs}`;
              const badgeUrl = `${SITE.url}${badgePath}`;
              const targetUrl = `${SITE.url}/benchmarks/${card.benchSlug}${qs}`;
              const tierLabel = card.tier ? (card.tier === "keyed" ? "private cohort" : `${card.tier} cohort`) : null;
              const scopeSuffix = `${card.chain ? ` on ${card.chain.label}` : ""}${card.region ? ` from ${card.region.label}` : ""}${tierLabel ? `, ${tierLabel}` : ""}`;
              const scopeLabels = [card.chain?.label, card.region?.label, tierLabel]
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
                        is community-run, so a pre-filled tweet praising
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
