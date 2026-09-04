import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { MetadataRoute } from "next";
import { getAllReports, getAllReportCategories } from "@/lib/reports/loader";
import { COMPARE_PAIRS } from "@/data/compare-pairs";
import { REMOVED_BENCH_SLUGS } from "@/middleware";
import { REMOVED_PRODUCT_SLUGS } from "@/lib/removed-benches";
import { isHlBuilderSlug } from "@/lib/hl-builder-stats";
import { PERP_PRODUCT_PILL_SLUGS } from "@/lib/perp-venue-context";
import { loadAllAlternatives } from "@/lib/alternatives";
import { loadAllAnswers } from "@/lib/answers";
import { CHAIN_BY_SLUG, CHAINS } from "@/lib/chains";
import { canonicalChainSlug } from "@/lib/chain-aliases";
import { CATEGORIES } from "@/lib/categories";
import { SITE } from "@/data/site";
import { loadSitemapBlob, type SitemapBench } from "@/lib/sitemap-blob";
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

function reportsRoutes(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [
    {
      url: `${SITE.url}/reports`,
      lastModified: BUILD_TIME,
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];
  try {
    for (const cat of getAllReportCategories()) {
      entries.push({
        url: `${SITE.url}/reports/${cat}`,
        lastModified: BUILD_TIME,
        changeFrequency: "monthly",
        priority: 0.7,
      });
    }
    for (const r of getAllReports()) {
      entries.push({
        url: `${SITE.url}/reports/${r.categorySlug}/${r.slug}`,
        lastModified: new Date(r.publishedAt),
        changeFrequency: "monthly",
        priority: 0.85,
      });
    }
  } catch {
    // content dir may not exist yet
  }
  return entries;
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
    { url: `${SITE.url}/bridge`, lastModified: catalogTs, changeFrequency: "hourly", priority: 0.9 },
    { url: `${SITE.url}/mcp`, lastModified: pageMtime("mcp/page.tsx"), changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE.url}/speedtest-rpc`, lastModified: pageMtime("speedtest-rpc/page.tsx"), changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE.url}/rpc-map`, lastModified: pageMtime("rpc-map/page.tsx"), changeFrequency: "daily", priority: 0.8 },
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
 *  those three paths are filesystem driven and never depend on KV.
 *  Only emits /chains/<slug> when a matching bench YAML exists on disk
 *  (convention: <slug>-rpc.yml) so chains without bench pages don't
 *  land in the sitemap and fail the smoke gate. */
async function buildStaticFallback(): Promise<MetadataRoute.Sitemap> {
  const answers = await safeLoad<Answer[]>(
    "answers (fallback)",
    () => loadAllAnswers(),
    [],
  );
  const benchesDir = path.join(process.cwd(), "benchmarks");
  const chainRoutes: MetadataRoute.Sitemap = CHAINS.flatMap((c) => {
    // Only emit the chain hub when a known bench YAML exists for it.
    // Convention: <chain-slug>-rpc.yml is the primary match.
    const hasRpc = (() => {
      try { readFileSync(path.join(benchesDir, `${c.slug}-rpc.yml`)); return true; } catch { return false; }
    })();
    if (!hasRpc) return [];
    return [{
      url: `${SITE.url}/chains/${c.slug}`,
      lastModified: BUILD_TIME,
      changeFrequency: "daily" as const,
      priority: 0.85,
    }];
  });
  const fallback: MetadataRoute.Sitemap = [
    ...staticHubRoutes(BUILD_TIME),
    ...chainRoutes,
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
  // Load slim sitemap blob (~50 KB) and filesystem-derived data in parallel.
  const [sitemapBlob, alternatives, answers] = await Promise.all([
    safeLoad("sitemap-blob", () => loadSitemapBlob(), null),
    safeLoad<Awaited<ReturnType<typeof loadAllAlternatives>>>(
      "alternatives",
      () => loadAllAlternatives(),
      [],
    ),
    safeLoad<Answer[]>("answers", () => loadAllAnswers(), []),
  ]);

  // If the blob is unavailable fall through to buildStaticFallback via the
  // caller's catch. This keeps parity with the old getBenchmarksSafe path.
  if (!sitemapBlob) throw new Error("[sitemap] sitemap-blob unavailable, falling back");

  const blobBenches: SitemapBench[] = sitemapBlob.benches;
  const providerSlugs: string[] = sitemapBlob.providerSlugs;
  const hlBuilderSlugSet = new Set(sitemapBlob.hlBuilderSlugs);

  // catalogTs: max lastRunAt across all blob benches.
  const catalogLastRun = blobBenches.reduce<Date>((acc, b) => {
    if (!b.lastRunAt) return acc;
    const t = new Date(b.lastRunAt);
    return t > acc ? t : acc;
  }, new Date(0));
  const catalogTs = catalogLastRun.getTime() > 0 ? catalogLastRun : BUILD_TIME;

  const benchBySlug = new Map(blobBenches.map((b) => [b.slug, b]));

  const alternativeLastRun = new Map<string, Date>();
  for (const alt of alternatives) {
    const bench = benchBySlug.get(alt.benchmark);
    if (bench?.lastRunAt) {
      alternativeLastRun.set(alt.slug, new Date(bench.lastRunAt));
    }
  }

  const staticRoutes = staticHubRoutes(catalogTs);

  // Benchmark routes. Blob benches are already filtered to live+live by
  // the worker. We still drop REMOVED_BENCH_SLUGS (middleware 410s them).
  const benchmarkRoutes: MetadataRoute.Sitemap = blobBenches.flatMap((b) => {
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
    // Per-chain sub-pages. The blob carries perChainSlugs which are the
    // slugs from perChainExplainer that the worker already validated
    // against results and chain dimensions.
    for (const chainSlug of b.perChainSlugs) {
      const canon = canonicalChainSlug(chainSlug);
      entries.push({
        url: `${SITE.url}/benchmarks/${b.slug}/${canon}`,
        lastModified: last,
        changeFrequency: "hourly",
        priority: 0.85,
      });
    }
    return entries;
  });

  // Provider routes. The worker pre-filters providerSlugs to exclude chain
  // slugs, HL builder slugs, perp venue slugs, and removed slugs. Apply the
  // same checks here as a safety net. isHlBuilderSlug reads the spec (not
  // Prom) so it's safe async — no OOM risk (unlike the old getProvider fan-out).
  // It also catches dormant HL frontends missing from the Prom cohort that
  // the worker couldn't filter without the spec provider list.
  const validatedSlugs = (
    await Promise.all(
      providerSlugs.map(async (slug) => {
        if (CHAIN_BY_SLUG.has(slug)) return null;
        if (hlBuilderSlugSet.has(slug)) return null;
        if (await isHlBuilderSlug(slug)) return null;
        if (PERP_PRODUCT_PILL_SLUGS.has(slug) && slug !== "polymarket") return null;
        if (REMOVED_PRODUCT_SLUGS.has(slug)) return null;
        return slug;
      }),
    )
  ).filter((s): s is string => s !== null);

  const providerRoutes: MetadataRoute.Sitemap = validatedSlugs.map((slug) => ({
    url: `${SITE.url}/products/${slug}`,
    lastModified: catalogTs,
    changeFrequency: "daily",
    priority: 0.85,
  }));

  // Hyperliquid builder routes. The worker pre-filters to builders with
  // history so we don't need isHlBuilderWithHistory here.
  const hlBuilderRoutes: MetadataRoute.Sitemap = sitemapBlob.hlBuilderSlugs.map(
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

  // Chain hub routes. Use chainDimensions from the blob to determine
  // which chains have active benches, mirroring getBenchmarksForChain logic.
  const chainsWithBenches = new Set<string>();
  for (const b of blobBenches) {
    for (const chainSlug of b.chainDimensions) {
      chainsWithBenches.add(canonicalChainSlug(chainSlug));
    }
  }
  const chainRoutes: MetadataRoute.Sitemap = CHAINS.flatMap((c) => {
    if (!chainsWithBenches.has(c.slug)) return [];
    // lastRunAt: max over benches that touch this chain.
    const last = blobBenches.reduce<Date>((acc, b) => {
      if (!b.chainDimensions.includes(c.slug) && !b.chainDimensions.map(canonicalChainSlug).includes(c.slug)) return acc;
      if (!b.lastRunAt) return acc;
      const t = new Date(b.lastRunAt);
      return t > acc ? t : acc;
    }, new Date(0));
    return [{
      url: `${SITE.url}/chains/${c.slug}`,
      lastModified: last.getTime() > 0 ? last : catalogTs,
      changeFrequency: "daily" as const,
      priority: 0.85,
    }];
  });

  // Compare routes. When using the slim blob we emit only COMPARE_PAIRS
  // (curated editorial pairs). Ad-hoc pair generation requires full
  // ProviderProfile data from getBenchmarksSafe() which is the 4 MB blob
  // we're avoiding. The curated pairs cover the high-value compare URLs.
  const compareRoutes: MetadataRoute.Sitemap = COMPARE_PAIRS.map((pair) => ({
    url: `${SITE.url}/compare/${pair.slug}`,
    lastModified: catalogTs,
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));

  // Category hub pages. Filter to categories that have live benches.
  // Exclude REMOVED_BENCH_SLUGS so benches with stale Redis data (410 on
  // prod) don't keep their category hub alive in the sitemap.
  const activeBlobBenches = blobBenches.filter((b) => !REMOVED_BENCH_SLUGS.has(b.slug));
  const liveCategoryLabels = new Set(activeBlobBenches.map((b) => b.category));
  const categoryRoutes: MetadataRoute.Sitemap = CATEGORIES
    .filter((c) => liveCategoryLabels.has(c.label))
    .map((c) => {
      const catBenches = activeBlobBenches.filter((b) => b.category === c.label);
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
    ...reportsRoutes(),
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
    // 75 s: smoke-test per-attempt timeout is 90 s (getTextWithRetry in
    // scripts/sitemap-smoke.mjs). The JS deadline must fire with enough
    // time left for buildStaticFallback() to return before that 90 s
    // window closes. FETCH_TIMEOUT_MS on /api/aggregate is 65 s, so the
    // worst-case aggregate-only path is ~65 s; 75 s gives 10 s of buffer
    // before the full build falls back. maxDuration on the route is 300 s,
    // so the process exits cleanly (~76 s) long before the platform SIGKILL.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("sitemap build timeout")), 75_000),
    );
    // Attach a no-op .catch() to prevent unhandled-rejection crashes if
    // buildFullSitemap() rejects AFTER the race has already settled (via
    // timeout). Without this, the orphaned promise's rejection propagates
    // to Node's unhandledRejection handler and Vercel returns 500 even
    // though we already sent a 200 static fallback.
    const full = buildFullSitemap();
    full.catch(() => {});
    return await Promise.race([full, timeout]);
  } catch (err) {
    console.warn(
      "[sitemap] full build threw or timed out, returning static fallback:",
      err,
    );
    return buildStaticFallback();
  }
}
