import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { MetadataRoute } from "next";
import { getBenchmarks } from "@/data/benchmarks";
import { COMPARE_PAIRS } from "@/data/compare-pairs";
import { adHocPairs } from "@/lib/compare/adhoc-pairs";
import { REMOVED_BENCH_SLUGS } from "@/middleware";
import {
  isHlBuilderSlug,
  isHlBuilderWithHistory,
} from "@/lib/hl-builder-stats";
import { loadAllAlternatives } from "@/lib/alternatives";
import { loadAllAnswers } from "@/lib/answers";
import { CHAIN_BY_SLUG, CHAINS, getBenchmarksForChain } from "@/lib/chains";
import { canonicalChainSlug } from "@/lib/chain-aliases";
import { getProvider, getProviders, getProviderSlugs } from "@/lib/providers";
import { CATEGORIES } from "@/lib/categories";
import { SITE } from "@/data/site";
import type { Benchmark } from "@/types/benchmark";
import type { Answer } from "@/lib/answers";

// Was previously `force-static` + `revalidate: false`, which baked the
// sitemap at build time and never refreshed it (dropped freshly added
// benches from the sitemap until someone redeployed).
//
// Then we used `revalidate: 3600` — until the sitemap grew past 2.4 MB
// once the HL frontends bench shipped 104 builders × multiple route
// variants. Next's Data Cache hard-caps at 2 MB per item, every build
// failed with "Failed to build /sitemap.xml/route after 3 attempts".
//
// Now on `force-dynamic`: runs at request time, never goes through the
// 2 MB Data Cache, explicit Cache-Control held edge-side for an hour.
//
// Even on dynamic, Next still discovers the route at build time. If
// the data loaders inside throw (KV blackout, Prom timeout, snapshot
// schema mismatch) the build fails. The whole function is wrapped in
// a top-level try/catch so a transient outage falls back to a static
// surface (static routes + chains + answers) and the build still
// succeeds; the next ISR refresh recovers automatically.
export const dynamic = "force-dynamic";

// Stable per deploy, not per request. process.env.NEXT_PUBLIC_BUILD_TIME
// is injected in next.config.ts at build time. Falling back to new Date()
// keeps local dev working. Critical: must NOT be `new Date()` at request
// time because the sitemap runs on force-dynamic (see header comment) so
// every Google crawl would otherwise see a fresh lastmod on every URL
// and Google would discard the signal as unreliable sitewide.
const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME
  ? new Date(process.env.NEXT_PUBLIC_BUILD_TIME)
  : new Date();
// Vercel's build container doesn't preserve git-checkout mtimes — every
// file gets reset to the build-system default (Oct 20 2018), which leaks
// into the sitemap as `<lastmod>2018-10-20T...</lastmod>` for editorial
// hub pages and tells Google these pages haven't moved in years. Anything
// pre-dating the codebase is garbage; fall back to BUILD_TIME so the
// crawler sees a current timestamp and keeps the pages in the warm pool.
const REAL_REPO_BIRTH = new Date("2024-01-01");

// Prebuilt manifest of `src/app/<rel>` → git-log %ct (Unix seconds) for
// editorial hub pages. Written by scripts/emit-page-mtimes.ts during
// prebuild so the sitemap can emit a real per-page <lastmod> derived
// from git history, instead of Vercel's build-container mtime (which
// resets every file to Oct 20 2018). Missing entries silently fall
// through to the statSync path below, then to BUILD_TIME. Read once
// at module scope so /sitemap.xml doesn't restat the file per page.
const MTIME_MANIFEST_PATH = path.join(
  process.cwd(),
  "data",
  "page-mtimes.json",
);
const MTIME_MANIFEST: Record<string, number> = (() => {
  try {
    return JSON.parse(readFileSync(MTIME_MANIFEST_PATH, "utf8"));
  } catch {
    return {};
  }
})();

function pageMtime(relPath: string): Date {
  const gitSeconds = MTIME_MANIFEST[relPath];
  if (typeof gitSeconds === "number" && Number.isFinite(gitSeconds)) {
    const gitDate = new Date(gitSeconds * 1000);
    if (gitDate > REAL_REPO_BIRTH) return gitDate;
  }
  try {
    const mtime = statSync(path.join(process.cwd(), "src/app", relPath)).mtime;
    if (mtime < REAL_REPO_BIRTH) return BUILD_TIME;
    return mtime;
  } catch {
    return BUILD_TIME;
  }
}

async function safeLoad<T>(
  label: string,
  loader: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await loader();
  } catch (err) {
    console.warn(
      `[sitemap] ${label} loader threw, falling back to empty:`,
      err,
    );
    return fallback;
  }
}

function staticHubRoutes(catalogTs: Date): MetadataRoute.Sitemap {
  return [
    { url: SITE.url, lastModified: catalogTs, changeFrequency: "daily", priority: 1.0 },
    { url: `${SITE.url}/benchmarks`, lastModified: catalogTs, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE.url}/products`, lastModified: catalogTs, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE.url}/hyperliquid`, lastModified: catalogTs, changeFrequency: "hourly", priority: 0.9 },
    { url: `${SITE.url}/prediction-markets`, lastModified: catalogTs, changeFrequency: "hourly", priority: 0.9 },
    { url: `${SITE.url}/rpc`, lastModified: catalogTs, changeFrequency: "hourly", priority: 0.9 },
    { url: `${SITE.url}/perps`, lastModified: catalogTs, changeFrequency: "hourly", priority: 0.9 },
    { url: `${SITE.url}/mcp`, lastModified: pageMtime("mcp/page.tsx"), changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE.url}/methodology`, lastModified: pageMtime("methodology/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/contribute`, lastModified: pageMtime("contribute/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/partners`, lastModified: pageMtime("partners/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/badges`, lastModified: catalogTs, changeFrequency: "daily", priority: 0.7 },
    { url: `${SITE.url}/about`, lastModified: pageMtime("about/page.tsx"), changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE.url}/team`, lastModified: pageMtime("team/page.tsx"), changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE.url}/press`, lastModified: pageMtime("press/page.tsx"), changeFrequency: "monthly", priority: 0.4 },
    { url: `${SITE.url}/compare`, lastModified: pageMtime("compare/page.tsx"), changeFrequency: "weekly", priority: 0.6 },
    { url: `${SITE.url}/alternatives`, lastModified: pageMtime("alternatives/page.tsx"), changeFrequency: "weekly", priority: 0.6 },
    { url: `${SITE.url}/answers`, lastModified: catalogTs, changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE.url}/chains`, lastModified: catalogTs, changeFrequency: "weekly", priority: 0.7 },
  ];
}

/** Last-resort sitemap, returned when even buildFullSitemap throws.
 *  Emits the static hubs + every chain hub + every answer URL because
 *  those three paths are filesystem driven and never depend on KV. */
async function buildStaticFallback(): Promise<MetadataRoute.Sitemap> {
  const answers = await safeLoad<Answer[]>(
    "answers (fallback)",
    () => loadAllAnswers(),
    [],
  );
  const fallback: MetadataRoute.Sitemap = [
    ...staticHubRoutes(BUILD_TIME),
    ...CHAINS.map((c) => ({
      url: `${SITE.url}/chains/${c.slug}`,
      lastModified: BUILD_TIME,
      changeFrequency: "daily" as const,
      priority: 0.85,
    })),
    ...answers.map((a) => ({
      url: `${SITE.url}/answers/${a.slug}`,
      lastModified: BUILD_TIME,
      changeFrequency: "daily" as const,
      priority: 0.85,
    })),
  ];
  return fallback;
}

async function buildFullSitemap(): Promise<MetadataRoute.Sitemap> {
  const [benchmarks, alternatives, answers, providerSlugs] = await Promise.all([
    safeLoad<Benchmark[]>("benchmarks", () => getBenchmarks(), []),
    safeLoad<Awaited<ReturnType<typeof loadAllAlternatives>>>(
      "alternatives",
      () => loadAllAlternatives(),
      [],
    ),
    safeLoad<Answer[]>("answers", () => loadAllAnswers(), []),
    safeLoad<string[]>("providerSlugs", () => getProviderSlugs(), []),
  ]);

  // Most-recent bench lastRunAt per provider, so /products/<slug>'s
  // lastmod reflects fresh data on any of its benches.
  const providerLastRun = new Map<string, Date>();
  for (const b of benchmarks) {
    if (!b.lastRunAt) continue;
    const runAt = new Date(b.lastRunAt);
    for (const r of b.results) {
      const k = r.slug.toLowerCase();
      const cur = providerLastRun.get(k);
      if (!cur || runAt > cur) providerLastRun.set(k, runAt);
    }
  }

  const catalogLastRun = benchmarks.reduce<Date>((acc, b) => {
    if (!b.lastRunAt) return acc;
    const t = new Date(b.lastRunAt);
    return t > acc ? t : acc;
  }, new Date(0));
  const catalogTs = catalogLastRun.getTime() > 0 ? catalogLastRun : BUILD_TIME;

  const benchBySlug = new Map(benchmarks.map((b) => [b.slug, b]));
  const alternativeLastRun = new Map<string, Date>();
  for (const alt of alternatives) {
    const bench = benchBySlug.get(alt.benchmark);
    if (bench?.lastRunAt) {
      alternativeLastRun.set(alt.slug, new Date(bench.lastRunAt));
    }
  }

  const staticRoutes = staticHubRoutes(catalogTs);

  const benchmarkRoutes: MetadataRoute.Sitemap = benchmarks.flatMap((b) => {
    // Middleware returns 410 for these slugs on prod (see middleware.ts).
    // Emitting them in the sitemap advertises URLs the middleware will
    // then reject, failing the deploy-time sitemap-smoke gate.
    if (REMOVED_BENCH_SLUGS.has(b.slug)) return [];
    const last = b.lastRunAt ? new Date(b.lastRunAt) : BUILD_TIME;
    const entries: MetadataRoute.Sitemap = [
      {
        url: `${SITE.url}/benchmarks/${b.slug}`,
        lastModified: last,
        changeFrequency: "hourly",
        priority: 0.95,
      },
    ];
    // Canonicalize at insertion + check time so a chain rebrand window
    // (where YAML dimension still has the legacy value "ton" while
    // perChainExplainer + chain registry have moved to "gram") doesn't
    // drop the new URLs from the sitemap. Emit the canonical URL so
    // crawlers never index legacy /ton paths that 308 to /gram.
    const resultSlugs = new Set(
      b.results.map((r) => canonicalChainSlug(r.slug)),
    );
    const chainValues = new Set(
      (b.dimensions?.chain ?? [])
        .filter((c) => c.value.toLowerCase() !== "all")
        .map((c) => canonicalChainSlug(c.value)),
    );
    for (const e of b.perChainExplainer ?? []) {
      const canon = canonicalChainSlug(e.slug);
      if (!resultSlugs.has(canon) && !chainValues.has(canon)) continue;
      entries.push({
        url: `${SITE.url}/benchmarks/${b.slug}/${canon}`,
        lastModified: last,
        changeFrequency: "hourly",
        priority: 0.85,
      });
    }
    return entries;
  });

  // Validate every slug against getProvider() so the sitemap can never
  // ship a /products/<slug> URL that the page would 404 on. The page
  // calls `getProvider(slug)` and renders notFound() when it returns
  // undefined, so this is the exact filter generateStaticParams would
  // need to apply if it were prerendering the route. Without this
  // guard, Google indexed soft 404s for slugs the sitemap claimed
  // existed (quicknode, coingecko, infura, ankr were all flagged).
  //
  // Also drop any slug that matches a chain in the registry. Those
  // /products/<chain> URLs 308 to /chains/<chain> since the URL move,
  // so listing them in the sitemap pollutes it with permanent
  // redirects. The canonical /chains/<slug> URLs are emitted below
  // by chainRoutes.
  // Pre-warm the HL-builder slug cache with a single call so the
  // Promise.all below doesn't race 100 concurrent getSpecs() reads
  // (each awaits the same spec load before the cache initializes,
  // exhausting the file-descriptor pool and timing out on prod).
  //
  // Tracked Hyperliquid builder frontends live under /hyperliquid/<slug>;
  // /products/<slug> 308-redirects for these slugs (products/[slug]
  // /page.tsx), and the deploy-time sitemap-smoke gate rolls back on
  // any 3xx. The canonical /hyperliquid/<slug> URLs are emitted below
  // from the hyperliquid-frontends spec providers (a previous comment
  // claimed Next auto-discovers them from generateStaticParams; no such
  // mechanism exists, which is why 92 builder pages were missing from
  // the sitemap until 2026-07-12).
  await isHlBuilderSlug("").catch(() => false);
  const validatedSlugs = (
    await Promise.all(
      providerSlugs.map(async (slug) => {
        if (CHAIN_BY_SLUG.has(slug)) return null;
        if (await isHlBuilderSlug(slug)) return null;
        const p = await getProvider(slug);
        return p ? slug : null;
      }),
    )
  ).filter((s): s is string => s !== null);

  const providerRoutes: MetadataRoute.Sitemap = validatedSlugs.map((slug) => ({
    url: `${SITE.url}/products/${slug}`,
    lastModified: providerLastRun.get(slug.toLowerCase()) ?? catalogTs,
    changeFrequency: "daily",
    priority: 0.85,
  }));

  // Hyperliquid builder detail pages. Emitted from the spec provider
  // list (static per deploy, same source as the 308 gate in
  // products/[slug]), minus raw hex-address builder slugs which have no
  // durable page. Also skip builders with no resolvable history — the
  // page 307-redirects them to /hyperliquid (see
  // hyperliquid/[slug]/page.tsx:92), which Google treats as soft-404
  // and pollutes crawl budget. isHlBuilderWithHistory shares the same
  // fetchHlHistory unstable_cache the page uses, so the two stay in
  // lockstep.
  const HEX_BUILDER_SLUG = /^0x[a-f0-9]+$/;
  const hlBuilderSlugs = (
    await Promise.all(
      providerSlugs.map(async (slug) =>
        !HEX_BUILDER_SLUG.test(slug) && (await isHlBuilderWithHistory(slug))
          ? slug
          : null,
      ),
    )
  ).filter((s): s is string => s !== null);
  const hlBuilderRoutes: MetadataRoute.Sitemap = hlBuilderSlugs.map(
    (slug) => ({
      url: `${SITE.url}/hyperliquid/${slug}`,
      lastModified: catalogTs,
      changeFrequency: "daily",
      priority: 0.7,
    }),
  );

  const alternativeRoutes: MetadataRoute.Sitemap = alternatives
    .filter((alt) => benchBySlug.has(alt.benchmark))
    .map((alt) => ({
      url: `${SITE.url}/alternatives/${alt.slug}`,
      lastModified: alternativeLastRun.get(alt.slug) ?? catalogTs,
      changeFrequency: "daily",
      priority: 0.85,
    }));

  const answerRoutes: MetadataRoute.Sitemap = answers
    .filter((a) => benchBySlug.has(a.benchmark))
    .map((a) => {
      const bench = benchBySlug.get(a.benchmark);
      const last = bench?.lastRunAt ? new Date(bench.lastRunAt) : catalogTs;
      return {
        url: `${SITE.url}/answers/${a.slug}`,
        lastModified: last,
        changeFrequency: "daily" as const,
        priority: 0.85,
      };
    });

  // Only emit /chains/<slug> in the sitemap when the page will actually
  // render 200. The page 404s (chains/[slug]/page.tsx:91) when
  // getBenchmarksForChain returns []; emitting an unrenderable URL fails
  // the sitemap-smoke gate and rolls back every prod deploy.
  //
  // 9 long-tail chains (sonic, gnosis, celo, moonbeam, unichain, soneium,
  // berachain, fraxtal, cronos) have per-chain RPC benches under distinct
  // slugs (`sonic-rpc.yml`, etc.) but do NOT appear in any bench's
  // `results[].slug` or `dimensions.chain[]`, so getBenchmarksForChain
  // returns 0. Once those benches expose a chain dimension the URL will
  // re-enter the sitemap automatically. On the transient throw path we
  // still emit — a Prom outage should not disappear known-good chain
  // hubs from the sitemap.
  const chainRoutes: MetadataRoute.Sitemap = (
    await Promise.all(
      CHAINS.map(async (c) => {
        try {
          const benches = await getBenchmarksForChain(c.slug);
          if (benches.length === 0) return null;
          const last = benches.reduce<Date>((acc, b) => {
            if (!b.lastRunAt) return acc;
            const t = new Date(b.lastRunAt);
            return t > acc ? t : acc;
          }, new Date(0));
          return {
            url: `${SITE.url}/chains/${c.slug}`,
            lastModified: last.getTime() > 0 ? last : catalogTs,
            changeFrequency: "daily" as const,
            priority: 0.85,
          };
        } catch {
          return {
            url: `${SITE.url}/chains/${c.slug}`,
            lastModified: catalogTs,
            changeFrequency: "daily" as const,
            priority: 0.85,
          };
        }
      }),
    )
  ).filter((r): r is NonNullable<typeof r> => r !== null);

  // Compare pair sitemap. Combines curated pairs (editorial anchors)
  // with ad-hoc pairs that clear a live-data gate: both providers share
  // at least 2 benchmarks with p50 > 0. That gate keeps thin content
  // (providers barely overlapping) out of the sitemap while surfacing
  // genuinely comparable pairs Google was already crawling via internal
  // "vs" cross-sell links but couldn't rank because no sitemap signal.
  //
  // HL hex slugs + chain slugs are excluded inside adHocPairs (shared
  // enumeration in src/lib/compare/adhoc-pairs.ts).
  const compareRoutes: MetadataRoute.Sitemap = [];
  const emittedPairSlugs = new Set<string>();
  const priorityByPairSlug = new Map<string, number>();
  const lastModByPairSlug = new Map<string, Date>();

  // Precompute the set of provider + chain slugs each benchmark touches.
  // Used to derive per-pair <lastmod> from the max lastRunAt over their
  // shared benchmarks (see per-URL lastmod SEO audit). One pass over
  // benchmarks; per-pair lookup is then two Set.has() calls.
  const benchToParticipants = new Map<string, Set<string>>();
  for (const b of benchmarks) {
    const participants = new Set<string>();
    for (const r of b.results) participants.add(r.slug.toLowerCase());
    for (const c of b.dimensions?.chain ?? []) {
      const v = c.value.toLowerCase();
      if (v !== "all") participants.add(v);
    }
    benchToParticipants.set(b.slug, participants);
  }

  const pairLastMod = (aSlug: string, bSlug: string): Date => {
    const a = aSlug.toLowerCase();
    const b = bSlug.toLowerCase();
    let max = new Date(0);
    for (const [benchSlug, participants] of benchToParticipants) {
      if (!participants.has(a) || !participants.has(b)) continue;
      const bench = benchBySlug.get(benchSlug);
      if (!bench?.lastRunAt) continue;
      const t = new Date(bench.lastRunAt);
      if (t > max) max = t;
    }
    return max.getTime() > 0 ? max : catalogTs;
  };

  for (const pair of COMPARE_PAIRS) {
    const p = await getProvider(pair.providerA);
    const q = await getProvider(pair.providerB);
    if (!p || !q) continue;
    emittedPairSlugs.add(pair.slug);
    priorityByPairSlug.set(pair.slug, 0.7);
    lastModByPairSlug.set(pair.slug, pairLastMod(pair.providerA, pair.providerB));
  }

  // Ad-hoc pair generation with hybrid threshold (SEO audit 2026-07-08,
  // tightened from 2026-07-05):
  //
  //   - Both providers in BRAND_WHITELIST → emit at ≥ 2 shared benches
  //     with live data for both.
  //   - Otherwise → emit only at ≥ 3 live shared benches.
  //
  // History: the original ≥ 1 for any pair generated 4938 ad-hoc URLs,
  // 97% near-duplicate templates; Bing indexed 2 of 5093 and penalised
  // the domain. The 07-05 hybrid (brand ≥ 1 structural) still emitted
  // ~70 single-shared-bench pairs, many rendering "awaiting live
  // measurements" (~2 KB). The ≥ 2 live floor matches the render-time
  // noindex gate on /compare/[slug], so no sitemap URL is noindexed.
  // Dropped pairs still render via the ad-hoc resolver (no 404s from
  // bench-page or product-page cross links).
  // Enumeration shared with /compare (src/lib/compare/adhoc-pairs.ts)
  // so every advertised pair URL is also internally linked — sitemap-
  // only pairs were flagged as orphan pages (Ahrefs, 2026-07-08).
  const profiles = await safeLoad("providers", () => getProviders(), []);
  for (const pair of adHocPairs(profiles)) {
    if (emittedPairSlugs.has(pair.slug)) continue;
    emittedPairSlugs.add(pair.slug);
    priorityByPairSlug.set(pair.slug, 0.5);
    lastModByPairSlug.set(pair.slug, pairLastMod(pair.a, pair.b));
  }

  for (const pairSlug of emittedPairSlugs) {
    compareRoutes.push({
      url: `${SITE.url}/compare/${pairSlug}`,
      lastModified: lastModByPairSlug.get(pairSlug) ?? catalogTs,
      changeFrequency: "weekly" as const,
      priority: priorityByPairSlug.get(pairSlug) ?? 0.5,
    });
  }

  // Category hub pages. Closed enum from CATEGORIES; prerendered
  // routes that group benches by domain (Blockchains, Bridges, …).
  // Per-URL <lastmod> = max lastRunAt of benches in the category.
  // Benchmark.category is the display label ("Aggregators"), CATEGORIES
  // entry has both label and slug — match on label.
  // Empty categories (currently "Wallets") 404 at the page component,
  // which fails the sitemap-smoke gate. Filter them here so a category
  // lit only by a spec status:draft doesn't leak into the sitemap.
  const liveCategoryLabels = new Set(benchmarks.map((b) => b.category));
  const categoryRoutes: MetadataRoute.Sitemap = CATEGORIES
    .filter((c) => liveCategoryLabels.has(c.label))
    .map((c) => {
      const catBenches = benchmarks.filter((b) => b.category === c.label);
      const last = catBenches.reduce<Date>((acc, b) => {
        if (!b.lastRunAt) return acc;
        const t = new Date(b.lastRunAt);
        return t > acc ? t : acc;
      }, new Date(0));
      return {
        url: `${SITE.url}/benchmarks/category/${c.slug}`,
        lastModified: last.getTime() > 0 ? last : catalogTs,
        changeFrequency: "weekly" as const,
        priority: 0.6,
      };
    });

  return [
    ...staticRoutes,
    ...benchmarkRoutes,
    ...providerRoutes,
    ...hlBuilderRoutes,
    ...alternativeRoutes,
    ...answerRoutes,
    ...chainRoutes,
    ...categoryRoutes,
    ...compareRoutes,
  ];
}

export async function buildSitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    return await buildFullSitemap();
  } catch (err) {
    console.warn(
      "[sitemap] full build threw, returning static fallback:",
      err,
    );
    return buildStaticFallback();
  }
}
