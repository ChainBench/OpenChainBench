import { statSync } from "node:fs";
import path from "node:path";
import type { MetadataRoute } from "next";
import { getBenchmarks } from "@/data/benchmarks";
import { loadAllAlternatives } from "@/lib/alternatives";
import { getProviderSlugs } from "@/lib/providers";
import { SITE } from "@/data/site";

export const dynamic = "force-static";
export const revalidate = false;

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

function pageMtime(relPath: string): Date {
  try {
    return statSync(path.join(process.cwd(), "src/app", relPath)).mtime;
  } catch {
    return BUILD_TIME;
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [benchmarks, alternatives, providerSlugs] = await Promise.all([
    getBenchmarks(),
    loadAllAlternatives(),
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
  ];

  // Bench routes. The hub URL (no query string) is the canonical entry
  // and ranks highest. Per-chain variants (`?chain=X`) are emitted as
  // secondary URLs so Google's crawler discovers the chain-honest
  // metadata / OG card pairs for each filter. We skip the "all" sentinel
  // (which maps to the canonical hub) and any chain dimension whose
  // value would collide with the hub after URL-encoding. Each variant
  // shares the parent bench's `lastModified` because the chain filter
  // doesn't change the underlying scrape cadence — they all refresh as
  // a single Prom poll. Priority is dropped one tier on variants so
  // Search Console reads the hub as the head of the cluster.
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
    const chains = (b.dimensions?.chain ?? []).filter(
      (c) => c.value && c.value.toLowerCase() !== "all",
    );
    for (const c of chains) {
      entries.push({
        url: `${SITE.url}/benchmarks/${b.slug}?chain=${encodeURIComponent(c.value)}`,
        lastModified: last,
        changeFrequency: "hourly",
        priority: 0.8,
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

  const alternativeRoutes: MetadataRoute.Sitemap = alternatives.map((alt) => ({
    url: `${SITE.url}/alternatives/${alt.slug}`,
    lastModified: alternativeLastRun.get(alt.slug) ?? catalogLastRun,
    changeFrequency: "daily",
    priority: 0.85,
  }));

  return [
    ...staticRoutes,
    ...benchmarkRoutes,
    ...providerRoutes,
    ...alternativeRoutes,
  ];
}
