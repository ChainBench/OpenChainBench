import { execFileSync } from "node:child_process";
import type { MetadataRoute } from "next";
import { getBenchmarkSlugs } from "@/data/benchmarks";
import { loadAlternativeSlugs } from "@/lib/alternatives";
import { getProviderSlugs } from "@/lib/providers";
import { SITE } from "@/data/site";

// Force build-time generation. Vercel's serverless runtime has no git
// binary and no .git directory, so the git-based lastmod lookup below
// only works during the build phase - if we let this revalidate every
// 60 s (the next.js default for fs-touching sitemaps), every refresh
// served a sitemap whose 118 URLs all reported the same fallback time.
// Static + force-static = generated once per deploy, served forever
// until the next push, which is also when lastmods need to update.
export const dynamic = "force-static";
export const revalidate = false;

// Each sitemap entry's `lastmod` should reflect the file's last *edit*,
// not the current request time and not the build's git-checkout time
// (statSync on Vercel returns the checkout timestamp, which makes every
// URL claim it changed simultaneously on every deploy - exactly the
// pattern Google downgrades sitemaps for).
//
// Use the file's last git-commit time instead. Available on Vercel's
// build env (full clone, not shallow for normal projects). Falls back to
// the build clock if git is unavailable (local dev with no commits) or
// the file isn't tracked yet.
const BUILD_TIME = new Date();
const gitMtimeCache = new Map<string, Date>();

function gitMtime(rel: string): Date {
  const cached = gitMtimeCache.get(rel);
  if (cached) return cached;
  try {
    const iso = execFileSync("git", ["log", "-1", "--format=%cI", "--", rel], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const d = iso ? new Date(iso) : BUILD_TIME;
    const out = Number.isNaN(d.getTime()) ? BUILD_TIME : d;
    gitMtimeCache.set(rel, out);
    return out;
  } catch {
    gitMtimeCache.set(rel, BUILD_TIME);
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
  const registryMtime = gitMtime("src/data/provider-registry.ts");

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: SITE.url, lastModified: gitMtime("src/app/page.tsx"), changeFrequency: "daily", priority: 1.0 },
    { url: `${SITE.url}/benchmarks`, lastModified: gitMtime("src/app/benchmarks/page.tsx"), changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE.url}/products`, lastModified: gitMtime("src/app/products/page.tsx"), changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE.url}/mcp`, lastModified: gitMtime("src/app/mcp/page.tsx"), changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE.url}/methodology`, lastModified: gitMtime("src/app/methodology/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/contribute`, lastModified: gitMtime("src/app/contribute/page.tsx"), changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE.url}/about`, lastModified: gitMtime("src/app/about/page.tsx"), changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE.url}/press`, lastModified: gitMtime("src/app/press/page.tsx"), changeFrequency: "monthly", priority: 0.4 },
  ];

  const benchmarkRoutes: MetadataRoute.Sitemap = slugs.map((slug) => ({
    url: `${SITE.url}/benchmarks/${slug}`,
    lastModified: gitMtime(`benchmarks/${slug}.yml`),
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
    lastModified: gitMtime(`alternatives/${slug}.yml`),
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
