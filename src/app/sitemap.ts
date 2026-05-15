import type { MetadataRoute } from "next";
import { getBenchmarkSlugs } from "@/data/benchmarks";
import { loadAlternativeSlugs } from "@/lib/alternatives";
import { getProviderSlugs } from "@/lib/providers";
import { getGlossarySlugs } from "@/data/glossary";
import { SITE } from "@/data/site";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [slugs, altSlugs, providerSlugs] = await Promise.all([
    getBenchmarkSlugs(),
    loadAlternativeSlugs(),
    getProviderSlugs(),
  ]);
  const glossarySlugs = getGlossarySlugs();
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: SITE.url, lastModified: now, changeFrequency: "daily", priority: 1.0 },
    { url: `${SITE.url}/benchmarks`, lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE.url}/providers`, lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE.url}/glossary`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE.url}/methodology`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/contribute`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/about`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE.url}/press`, lastModified: now, changeFrequency: "monthly", priority: 0.4 },
  ];

  const benchmarkRoutes: MetadataRoute.Sitemap = slugs.map((slug) => ({
    url: `${SITE.url}/benchmarks/${slug}`,
    lastModified: now,
    changeFrequency: "hourly",
    priority: 0.95,
  }));

  const providerRoutes: MetadataRoute.Sitemap = providerSlugs.map((slug) => ({
    url: `${SITE.url}/providers/${slug}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: 0.85,
  }));

  const glossaryRoutes: MetadataRoute.Sitemap = glossarySlugs.map((slug) => ({
    url: `${SITE.url}/glossary/${slug}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  const alternativeRoutes: MetadataRoute.Sitemap = altSlugs.map((slug) => ({
    url: `${SITE.url}/alternatives/${slug}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: 0.85,
  }));

  return [
    ...staticRoutes,
    ...benchmarkRoutes,
    ...providerRoutes,
    ...glossaryRoutes,
    ...alternativeRoutes,
  ];
}
