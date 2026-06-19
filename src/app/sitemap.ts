import { statSync } from "node:fs";
import path from "node:path";
import type { MetadataRoute } from "next";
import { getBenchmarks } from "@/data/benchmarks";
import { loadAllAlternatives } from "@/lib/alternatives";
import { loadAllAnswers } from "@/lib/answers";
import { CHAINS, getBenchmarksForChain } from "@/lib/chains";
import { CATEGORIES } from "@/lib/categories";
import { isAll } from "@/lib/dimensions";
import { getProviderSlugs } from "@/lib/providers";
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

const BUILD_TIME = new Date();
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

/** Parse an ISO timestamp safely. Malformed input → fallback instead of
 *  silently emitting `new Date(NaN)` (which serialises to epoch 0 and
 *  poisons every sitemap entry it touches with `<lastmod>1970-01-01</lastmod>`). */
function safeDate(iso: string | null | undefined, fallback: Date): Date {
  if (!iso) return fallback;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : d;
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
    { url: `${SITE.url}/mcp`, lastModified: pageMtime("mcp/page.tsx"), changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE.url}/methodology`, lastModified: pageMtime("methodology/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/contribute`, lastModified: pageMtime("contribute/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/partners`, lastModified: pageMtime("partners/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
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
    // Category hubs are filesystem-driven (no KV / no Prom) so they belong
    // in the static fallback alongside chain hubs and answers.
    ...CATEGORIES.map((c) => ({
      url: `${SITE.url}/benchmarks/category/${c.slug}`,
      lastModified: BUILD_TIME,
      changeFrequency: "daily" as const,
      priority: 0.8,
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
    const runAt = safeDate(b.lastRunAt, BUILD_TIME);
    for (const r of b.results) {
      const k = r.slug.toLowerCase();
      const cur = providerLastRun.get(k);
      if (!cur || runAt > cur) providerLastRun.set(k, runAt);
    }
  }

  const catalogLastRun = benchmarks.reduce<Date>((acc, b) => {
    if (!b.lastRunAt) return acc;
    const t = safeDate(b.lastRunAt, new Date(0));
    return t > acc ? t : acc;
  }, new Date(0));
  const catalogTs = catalogLastRun.getTime() > 0 ? catalogLastRun : BUILD_TIME;

  const benchBySlug = new Map(benchmarks.map((b) => [b.slug, b]));
  const alternativeLastRun = new Map<string, Date>();
  for (const alt of alternatives) {
    const bench = benchBySlug.get(alt.benchmark);
    if (bench?.lastRunAt) {
      alternativeLastRun.set(alt.slug, safeDate(bench.lastRunAt, catalogTs));
    }
  }

  const staticRoutes = staticHubRoutes(catalogTs);

  const benchmarkRoutes: MetadataRoute.Sitemap = benchmarks.flatMap((b) => {
    const last = safeDate(b.lastRunAt, BUILD_TIME);
    const entries: MetadataRoute.Sitemap = [
      {
        url: `${SITE.url}/benchmarks/${b.slug}`,
        lastModified: last,
        changeFrequency: "hourly",
        priority: 0.95,
      },
    ];
    const resultSlugs = new Set(b.results.map((r) => r.slug));
    const chainValues = new Set(
      (b.dimensions?.chain ?? [])
        .map((c) => c.value)
        .filter((v) => !isAll(v)),
    );
    for (const e of b.perChainExplainer ?? []) {
      if (!resultSlugs.has(e.slug) && !chainValues.has(e.slug)) continue;
      entries.push({
        url: `${SITE.url}/benchmarks/${b.slug}/${e.slug}`,
        lastModified: last,
        changeFrequency: "hourly",
        priority: 0.85,
      });
    }
    return entries;
  });

  const providerRoutes: MetadataRoute.Sitemap = providerSlugs.map((slug) => ({
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
      const last = safeDate(bench?.lastRunAt, catalogTs);
      return {
        url: `${SITE.url}/answers/${a.slug}`,
        lastModified: last,
        changeFrequency: "daily" as const,
        priority: 0.85,
      };
    });

  // Chain hub pages. Each load wrapped so a single chain failure can't
  // dropdown the whole batch. On error we still surface the URL because
  // the page route has its own empty-bench guard.
  const chainRoutes: MetadataRoute.Sitemap = (
    await Promise.all(
      CHAINS.map(async (c) => {
        try {
          const benches = await getBenchmarksForChain(c.slug);
          if (benches.length === 0) return null;
          const last = benches.reduce<Date>((acc, b) => {
            if (!b.lastRunAt) return acc;
            const t = safeDate(b.lastRunAt, new Date(0));
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

  // Category hub pages. Mirror the chain hub pattern: lastmod = max
  // lastRunAt across the benches in the category so freshly run data
  // bumps the per-category URL too. Categories that currently have zero
  // live benches drop from the sitemap (the page route 404s them too).
  const categoryRoutes: MetadataRoute.Sitemap = CATEGORIES.map((c) => {
    const inCategory = benchmarks.filter((b) => b.category === c.label);
    if (inCategory.length === 0) return null;
    const last = inCategory.reduce<Date>((acc, b) => {
      if (!b.lastRunAt) return acc;
      const t = safeDate(b.lastRunAt, new Date(0));
      return t > acc ? t : acc;
    }, new Date(0));
    return {
      url: `${SITE.url}/benchmarks/category/${c.slug}`,
      lastModified: last.getTime() > 0 ? last : catalogTs,
      changeFrequency: "daily" as const,
      priority: 0.8,
    };
  }).filter((r): r is NonNullable<typeof r> => r !== null);

  return [
    ...staticRoutes,
    ...benchmarkRoutes,
    ...providerRoutes,
    ...alternativeRoutes,
    ...answerRoutes,
    ...chainRoutes,
    ...categoryRoutes,
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
