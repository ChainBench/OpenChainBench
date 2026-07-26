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

export async function GET() {
  const entries = await buildSitemap();
  return new Response(serialize(entries), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      // Edge holds the sitemap for an hour + SWR window so the loader
      // chain only runs once per hour per region rather than on every
      // crawler hit. Aligns with the /api/citable header set in
      // next.config.ts.
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
