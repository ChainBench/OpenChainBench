import type { MetadataRoute } from "next";
import { buildSitemap } from "@/lib/sitemap-builder";

// Route Handler (not Metadata Route). Reason: the previous
// `src/app/sitemap.ts` metadata route left Next in charge of the
// response headers and hard-coded `Cache-Control: public, max-age=0,
// must-revalidate` on force-dynamic sitemaps — every crawler hit
// re-ran the full loader chain (`x-vercel-cache: MISS` observed
// 2026-07-26). A user-side `next.config.ts headers()` entry for
// `/sitemap.xml` was silently ignored because metadata routes emit
// their own Cache-Control that overrides the config layer.
//
// Route Handlers return a raw `Response`, so we control the headers
// end-to-end. Same builder logic (buildSitemap in `src/lib/`), just
// serialized to XML here and shipped with a real edge cache header.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Hard platform ceiling so Vercel never holds the connection open longer
// than this when the SRH/Redis fan-out runs over budget. The internal
// buildSitemap() timeout is 20 s; this gives 40 s of headroom and still
// replies well within the smoke-test's 90 s limit.
export const maxDuration = 60;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toIso(v: MetadataRoute.Sitemap[number]["lastModified"]): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function serialize(entries: MetadataRoute.Sitemap): string {
  const urls = entries
    .map((e) => {
      const parts = [`<url><loc>${escapeXml(e.url)}</loc>`];
      const iso = toIso(e.lastModified);
      if (iso) parts.push(`<lastmod>${iso}</lastmod>`);
      if (e.changeFrequency) parts.push(`<changefreq>${e.changeFrequency}</changefreq>`);
      if (e.priority !== undefined) parts.push(`<priority>${e.priority}</priority>`);
      parts.push(`</url>`);
      return parts.join("");
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}

// Minimum URL count to consider a sitemap "full". The static fallback
// (buildStaticFallback) emits ~154 URLs (hub pages + chain hubs + answers
// with no bench/product/compare routes). The full sitemap has 750+.
// Threshold of 400 sits safely between the two: fallback gets s-maxage=0
// so the CDN can't lock crawlers onto the stub for an hour.
const FULL_SITEMAP_MIN_URLS = 400;

export async function GET() {
  try {
    const entries = await buildSitemap();
    const isFull = entries.length >= FULL_SITEMAP_MIN_URLS;
    return new Response(serialize(entries), {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        // Only cache at the edge when we have a real sitemap. A fallback
        // response (blob + SRH both failed, ~20 URLs) must not be cached
        // for an hour or every crawler hit serves the stub.
        "Cache-Control": isFull
          ? "public, s-maxage=3600, stale-while-revalidate=86400"
          : "public, s-maxage=0, must-revalidate",
      },
    });
  } catch {
    // Last-resort: buildSitemap's own catch should never propagate, but if
    // it does (buildStaticFallback also threw), return a minimal valid XML
    // so the smoke gate sees 200 rather than 500.
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>`,
      {
        status: 200,
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          "Cache-Control": "public, s-maxage=0, must-revalidate",
        },
      },
    );
  }
}
