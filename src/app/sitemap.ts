import { statSync } from "node:fs";
import { join } from "node:path";
import type { MetadataRoute } from "next";
import { getBenchmarkSlugs } from "@/data/benchmarks";
import { loadAlternativeSlugs } from "@/lib/alternatives";
import { getProviderSlugs } from "@/lib/providers";
import { SITE } from "@/data/site";

// Read the file's modification time on disk so each sitemap entry reflects
// when its source was actually last edited, not the build time. Google
// downgrades sitemaps whose every URL reports lastmod = today every day
// (correctly suspecting a build-time-clock artefact instead of real edits).
//
// Falls back to the build time if the file is missing - keeps the sitemap
// from blowing up during incremental rollouts that delete a file before
// the route handler catches up.
const BUILD_TIME = new Date();
function fileMtime(rel: string): Date {
  try {
    return statSync(join(process.cwd(), rel)).mtime;
  } catch {
    return BUILD_TIME;
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [slugs, altSlugs, providerSlugs] = await Promise.all([
    getBenchmarkSlugs(),
    loadAlternativeSlugs(),
    getProviderSlugs(),
  ]);

  // The provider registry is a single hand-edited file, so every /products
  // page's lastmod is keyed off the same file. Bench yml and alternative
  // yml each have their own per-route source of truth.
  const registryMtime = fileMtime("src/data/provider-registry.ts");

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: SITE.url, lastModified: fileMtime("src/app/page.tsx"), changeFrequency: "daily", priority: 1.0 },
    { url: `${SITE.url}/benchmarks`, lastModified: fileMtime("src/app/benchmarks/page.tsx"), changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE.url}/products`, lastModified: fileMtime("src/app/products/page.tsx"), changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE.url}/mcp`, lastModified: fileMtime("src/app/mcp/page.tsx"), changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE.url}/methodology`, lastModified: fileMtime("src/app/methodology/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/contribute`, lastModified: fileMtime("src/app/contribute/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/about`, lastModified: fileMtime("src/app/about/page.tsx"), changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE.url}/press`, lastModified: fileMtime("src/app/press/page.tsx"), changeFrequency: "monthly", priority: 0.4 },
  ];

  const benchmarkRoutes: MetadataRoute.Sitemap = slugs.map((slug) => ({
    url: `${SITE.url}/benchmarks/${slug}`,
    lastModified: fileMtime(`benchmarks/${slug}.yml`),
    changeFrequency: "hourly",
    priority: 0.95,
  }));

  const providerRoutes: MetadataRoute.Sitemap = providerSlugs.map((slug) => ({
    url: `${SITE.url}/products/${slug}`,
    lastModified: registryMtime,
    changeFrequency: "daily",
    priority: 0.85,
  }));

  const alternativeRoutes: MetadataRoute.Sitemap = altSlugs.map((slug) => ({
    url: `${SITE.url}/alternatives/${slug}`,
    lastModified: fileMtime(`alternatives/${slug}.yml`),
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
