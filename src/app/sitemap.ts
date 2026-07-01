import { statSync } from "node:fs";
import path from "node:path";
import type { MetadataRoute } from "next";
import { getBenchmarks } from "@/data/benchmarks";
import { COMPARE_PAIRS } from "@/data/compare-pairs";
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

function pageMtime(relPath: string): Date {
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
    { url: `${SITE.url}/perps`, lastModified: catalogTs, changeFrequency: "hourly", priority: 0.9 },
    { url: `${SITE.url}/mcp`, lastModified: pageMtime("mcp/page.tsx"), changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE.url}/methodology`, lastModified: pageMtime("methodology/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/contribute`, lastModified: pageMtime("contribute/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/partners`, lastModified: pageMtime("partners/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/badges`, lastModified: catalogTs, changeFrequency: "daily", priority: 0.7 },
    { url: `${SITE.url}/about`, lastModified: pageMtime("about/page.tsx"), changeFrequency: "monthly", priority: 0.5 },
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
  const validatedSlugs = (
    await Promise.all(
      providerSlugs.map(async (slug) => {
        if (CHAIN_BY_SLUG.has(slug)) return null;
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

  // Chain hub pages. Emit one entry per chain in the registry, no
  // bench-count gate: every /chains/<slug> route exists and renders
  // its own empty-bench state, and these are the canonical URLs that
  // replace the /products/<chain> 308s filtered out above.
  const chainRoutes: MetadataRoute.Sitemap = (
    await Promise.all(
      CHAINS.map(async (c) => {
        try {
          const benches = await getBenchmarksForChain(c.slug);
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
  // HL builder hex slugs are excluded (they leak into the provider
  // catalog but /compare/0x…-vs-… 404s at render). Chain slugs are
  // excluded too — /compare pairs involving a chain still work but the
  // chain hub is the canonical surface, and cross-listing dilutes.
  const HEX_SLUG_RE = /^0x[0-9a-f]{4,}$/i;
  const compareRoutes: MetadataRoute.Sitemap = [];
  const emittedPairSlugs = new Set<string>();
  const priorityByPairSlug = new Map<string, number>();

  for (const pair of COMPARE_PAIRS) {
    const p = await getProvider(pair.providerA);
    const q = await getProvider(pair.providerB);
    if (!p || !q) continue;
    emittedPairSlugs.add(pair.slug);
    priorityByPairSlug.set(pair.slug, 0.7);
  }

  // Gate: a provider is "sitemap-eligible" as soon as it has ≥1 bench
  // appearance. The initial pass required 2 live benches with p50>0 —
  // way too strict because most cohort providers (HL builders, wallets,
  // trading terminals) participate in a single bench (`hyperliquid-frontends`
  // or a product-catalog listing) with rank data but no p50 latency.
  // That filter dropped ~1500 valid pages Ahref had already indexed via
  // internal cross-links, leaving them in "Indexed but not in sitemap"
  // limbo. Relaxed: emit any pair with ≥1 shared bench appearance.
  const profiles = await safeLoad("providers", () => getProviders(), []);
  const benchesBySlug = new Map<string, Set<string>>();
  for (const p of profiles) {
    if (HEX_SLUG_RE.test(p.slug)) continue;
    if (CHAIN_BY_SLUG.has(p.slug)) continue;
    const benches = new Set(p.appearances.map((a) => a.benchmark.slug));
    if (benches.size >= 1) benchesBySlug.set(p.slug, benches);
  }

  const slugList = [...benchesBySlug.keys()].sort();
  for (let i = 0; i < slugList.length; i += 1) {
    const aSlug = slugList[i];
    const aBenches = benchesBySlug.get(aSlug)!;
    for (let j = i + 1; j < slugList.length; j += 1) {
      const bSlug = slugList[j];
      const bBenches = benchesBySlug.get(bSlug)!;
      let shared = 0;
      for (const s of aBenches) if (bBenches.has(s)) shared += 1;
      if (shared < 1) continue;
      const pairSlug = `${aSlug}-vs-${bSlug}`;
      if (emittedPairSlugs.has(pairSlug)) continue;
      emittedPairSlugs.add(pairSlug);
      priorityByPairSlug.set(pairSlug, 0.5);
    }
  }

  for (const pairSlug of emittedPairSlugs) {
    compareRoutes.push({
      url: `${SITE.url}/compare/${pairSlug}`,
      lastModified: catalogTs,
      changeFrequency: "weekly" as const,
      priority: priorityByPairSlug.get(pairSlug) ?? 0.5,
    });
  }

  // Category hub pages. Closed enum from CATEGORIES; prerendered
  // routes that group benches by domain (Blockchains, Bridges, …).
  const categoryRoutes: MetadataRoute.Sitemap = CATEGORIES.map((c) => ({
    url: `${SITE.url}/benchmarks/category/${c.slug}`,
    lastModified: catalogTs,
    changeFrequency: "weekly" as const,
    priority: 0.6,
  }));

  return [
    ...staticRoutes,
    ...benchmarkRoutes,
    ...providerRoutes,
    ...alternativeRoutes,
    ...answerRoutes,
    ...chainRoutes,
    ...categoryRoutes,
    ...compareRoutes,
  ];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
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
