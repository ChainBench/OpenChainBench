import { statSync } from "node:fs";
import path from "node:path";
import type { MetadataRoute } from "next";
import { getBenchmarks } from "@/data/benchmarks";
import { loadAllAlternatives } from "@/lib/alternatives";
import { loadAllAnswers } from "@/lib/answers";
import { CHAINS, getBenchmarksForChain } from "@/lib/chains";
import { getProviderSlugs } from "@/lib/providers";
import { SITE } from "@/data/site";

// Was previously `force-static` + `revalidate: false`, which baked the
// sitemap at build time and never refreshed it. That dropped freshly
// added benches (l1-finality, network-fees, etc.) from the sitemap for
// every subsequent crawl until someone redeployed, which produced an
// impressions cliff in Search Console because Google deprioritized
// every URL the sitemap stopped listing. Hourly ISR keeps the YAML
// list, lastmod tags and chain variants accurate without paying a Prom
// query on every Google crawler hit.
export const revalidate = 3600;

// Sitemap lastmod strategy. The previous version hardcoded one
// SITE_LAST_EDIT constant for every editorial URL, which meant Google
// saw stale timestamps until someone remembered to bump it manually.
// Replaced with three real signals derived at build time:
//
//   - Bench detail pages: `bench.lastRunAt` from prom. Each harness
//     scrapes on its own cadence so the timestamps reflect actual data
//     churn.
//   - Provider pages: most-recent `lastRunAt` across the benches the
//     provider competes in.
//   - Aggregator hub pages (`/`, `/benchmarks`, `/products`): max
//     `bench.lastRunAt` across the catalog. Whenever any bench refreshes,
//     these hubs claim to have moved too — accurate from a crawler's
//     perspective since the hub HTML embeds bench leaderboards.
//   - Editorial hub pages (`/about`, `/methodology`, `/mcp`,
//     `/contribute`, `/press`): mtime of the corresponding `page.tsx`.
//     `fs.statSync` works at build time on Vercel (the page files are
//     on disk) and reflects real edits to the page content.
//   - Alternative pages: `lastRunAt` of the bench each alternative
//     wraps. An alternative page is a re-skin of a bench; when the
//     underlying data refreshes the alternative does too.

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

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [benchmarks, alternatives, answers, providerSlugs] = await Promise.all([
    getBenchmarks(),
    loadAllAlternatives(),
    loadAllAnswers(),
    getProviderSlugs(),
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

  // Catalog-wide most-recent bench run. Drives the lastmod of the three
  // hub pages that render bench leaderboards.
  const catalogLastRun = benchmarks.reduce<Date>((acc, b) => {
    if (!b.lastRunAt) return acc;
    const t = new Date(b.lastRunAt);
    return t > acc ? t : acc;
  }, new Date(0));

  // Most-recent lastRunAt across the benches each alternative references.
  // Looked up via the already-loaded `benchmarks` array rather than
  // re-fetching each alternative's bench (which would trigger N extra
  // Prom round-trips at build time).
  const benchBySlug = new Map(benchmarks.map((b) => [b.slug, b]));
  const alternativeLastRun = new Map<string, Date>();
  for (const alt of alternatives) {
    const bench = benchBySlug.get(alt.benchmark);
    if (bench?.lastRunAt) {
      alternativeLastRun.set(alt.slug, new Date(bench.lastRunAt));
    }
  }

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: SITE.url, lastModified: catalogLastRun, changeFrequency: "daily", priority: 1.0 },
    { url: `${SITE.url}/benchmarks`, lastModified: catalogLastRun, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE.url}/products`, lastModified: catalogLastRun, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE.url}/mcp`, lastModified: pageMtime("mcp/page.tsx"), changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE.url}/methodology`, lastModified: pageMtime("methodology/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/contribute`, lastModified: pageMtime("contribute/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/about`, lastModified: pageMtime("about/page.tsx"), changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE.url}/press`, lastModified: pageMtime("press/page.tsx"), changeFrequency: "monthly", priority: 0.4 },
    { url: `${SITE.url}/compare`, lastModified: pageMtime("compare/page.tsx"), changeFrequency: "weekly", priority: 0.6 },
    { url: `${SITE.url}/alternatives`, lastModified: pageMtime("alternatives/page.tsx"), changeFrequency: "weekly", priority: 0.6 },
    { url: `${SITE.url}/answers`, lastModified: catalogLastRun, changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE.url}/chains`, lastModified: catalogLastRun, changeFrequency: "weekly", priority: 0.7 },
  ];

  // Bench routes. The hub URL is the canonical entry and ranks highest.
  // `?chain=X` query variants are deliberately NOT emitted: those URLs
  // declare a canonical pointing at the unfiltered hub, so listing them
  // told Google to index pages that self-identify as duplicates (GSC
  // filed them under "Duplicate, Google chose different canonical").
  // The indexable per-chain surface is the dedicated route
  // `/benchmarks/<slug>/<chain>`, generated only for chains that carry a
  // hand-written `per_chain_explainer` entry (unique editorial content,
  // self-canonical). See src/app/benchmarks/[slug]/[chain]/page.tsx.
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
    const resultSlugs = new Set(b.results.map((r) => r.slug));
    const chainValues = new Set(
      (b.dimensions?.chain ?? [])
        .map((c) => c.value)
        .filter((v) => v.toLowerCase() !== "all"),
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
    lastModified: providerLastRun.get(slug.toLowerCase()) ?? catalogLastRun,
    changeFrequency: "daily",
    priority: 0.85,
  }));

  // Only list alternatives whose parent bench exists on this branch. Some
  // benches are deliberately held out of main (deleted YAMLs, 410 route),
  // and /alternatives/<slug> 404s when its bench is missing — emitting the
  // URL anyway feeds Google a sitemap entry that dead-ends.
  const alternativeRoutes: MetadataRoute.Sitemap = alternatives
    .filter((alt) => benchBySlug.has(alt.benchmark))
    .map((alt) => ({
      url: `${SITE.url}/alternatives/${alt.slug}`,
      lastModified: alternativeLastRun.get(alt.slug) ?? catalogLastRun,
      changeFrequency: "daily",
      priority: 0.85,
    }));

  // Same guard as alternatives: drop answers whose referenced bench is
  // not on this branch so we never feed Google a sitemap entry that
  // 404s. lastmod follows the bench so a fresh measurement bumps the
  // answer's timestamp too.
  const answerRoutes: MetadataRoute.Sitemap = answers
    .filter((a) => benchBySlug.has(a.benchmark))
    .map((a) => {
      const bench = benchBySlug.get(a.benchmark);
      const last = bench?.lastRunAt ? new Date(bench.lastRunAt) : catalogLastRun;
      return {
        url: `${SITE.url}/answers/${a.slug}`,
        lastModified: last,
        changeFrequency: "daily" as const,
        priority: 0.85,
      };
    });

  // Chain hub pages. Wrapped in try/catch per chain so a transient KV
  // hiccup on a single bench load can't fail the whole sitemap build.
  // On error we still emit the chain URL with catalogLastRun, keeping
  // the page crawlable; the empty-bench filter only fires when the
  // load actually succeeds and returns an empty list (which means the
  // chain genuinely has no benches yet).
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
            lastModified: last.getTime() > 0 ? last : catalogLastRun,
            changeFrequency: "daily" as const,
            priority: 0.85,
          };
        } catch {
          // KV blackout. Surface the URL anyway so we don't dropdown
          // entries from the sitemap between deploys; the page route
          // has its own empty-bench guard.
          return {
            url: `${SITE.url}/chains/${c.slug}`,
            lastModified: catalogLastRun,
            changeFrequency: "daily" as const,
            priority: 0.85,
          };
        }
      }),
    )
  ).filter((r): r is NonNullable<typeof r> => r !== null);

  return [
    ...staticRoutes,
    ...benchmarkRoutes,
    ...providerRoutes,
    ...alternativeRoutes,
    ...answerRoutes,
    ...chainRoutes,
  ];
}
