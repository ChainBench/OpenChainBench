import type { MetadataRoute } from "next";
import { getBenchmarks } from "@/data/benchmarks";
import { loadAlternativeSlugs } from "@/lib/alternatives";
import { getProviderSlugs } from "@/lib/providers";
import { SITE } from "@/data/site";

export const dynamic = "force-static";
export const revalidate = false;

// Sitemap lastmod strategy. Two attempts using statSync and git log both
// returned a single timestamp per URL on Vercel - the platform's git is
// shallow at build time and the serverless runtime has no git binary at
// all. Instead we use what we actually have at build time:
//
// - Bench detail pages: the bench's `lastRunAt` from Prometheus. Each
//   harness scrapes on its own cadence so the timestamps are naturally
//   varied (and are the *real* "last data refresh" for that bench - the
//   value Google would care about for a data page).
// - Hub pages and indexes: SITE_LAST_EDIT, a hand-bumped constant that
//   tracks editorial site-wide changes. Bump it when content changes.
// - Provider pages: the most recent lastRunAt of any bench the provider
//   appears in (= the freshest signal that page has new data to show).
// - Alternative pages: SITE_LAST_EDIT (alternative copy is editorial).
//
// Net effect: a sitemap with 15-20 distinct timestamps that move with
// actual data churn, not 118 URLs stamped with the build clock.

const SITE_LAST_EDIT = new Date("2026-05-22T20:00:00Z");

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [benchmarks, altSlugs, providerSlugs] = await Promise.all([
    getBenchmarks(),
    loadAlternativeSlugs(),
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

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: SITE.url, lastModified: SITE_LAST_EDIT, changeFrequency: "daily", priority: 1.0 },
    { url: `${SITE.url}/benchmarks`, lastModified: SITE_LAST_EDIT, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE.url}/products`, lastModified: SITE_LAST_EDIT, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE.url}/mcp`, lastModified: SITE_LAST_EDIT, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE.url}/methodology`, lastModified: SITE_LAST_EDIT, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/contribute`, lastModified: SITE_LAST_EDIT, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/about`, lastModified: SITE_LAST_EDIT, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE.url}/press`, lastModified: SITE_LAST_EDIT, changeFrequency: "monthly", priority: 0.4 },
  ];

  const benchmarkRoutes: MetadataRoute.Sitemap = benchmarks.map((b) => ({
    url: `${SITE.url}/benchmarks/${b.slug}`,
    lastModified: b.lastRunAt ? new Date(b.lastRunAt) : SITE_LAST_EDIT,
    changeFrequency: "hourly",
    priority: 0.95,
  }));

  const providerRoutes: MetadataRoute.Sitemap = providerSlugs.map((slug) => ({
    url: `${SITE.url}/products/${slug}`,
    lastModified: providerLastRun.get(slug.toLowerCase()) ?? SITE_LAST_EDIT,
    changeFrequency: "daily",
    priority: 0.85,
  }));

  const alternativeRoutes: MetadataRoute.Sitemap = altSlugs.map((slug) => ({
    url: `${SITE.url}/alternatives/${slug}`,
    lastModified: SITE_LAST_EDIT,
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
