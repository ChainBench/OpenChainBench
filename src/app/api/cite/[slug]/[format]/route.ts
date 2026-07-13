import { NextResponse } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import { citeBundle } from "@/lib/citation";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { SLUG_RE } from "@/lib/slug";

export const runtime = "nodejs";
export const revalidate = 3600;

/**
 * Per-bench citation file with the correct MIME type so Zotero,
 * EndNote, Mendeley, Google Scholar's "Cite" button and Perplexity's
 * cite-picker recognize it as an importable citation record rather than
 * a plain text blob.
 *
 * Four formats:
 *   - `bib` (application/x-bibtex)   BibTeX record for LaTeX toolchains.
 *   - `ris` (application/x-research-info-systems)  RIS record for
 *     Zotero, EndNote, Mendeley, Zotero-compatible tools.
 *   - `apa` (text/plain)   Ready-to-paste APA string.
 *   - `txt` (text/plain)   Ready-to-paste plain-language attribution.
 *
 * The content is the same as `/api/stat/{slug}.cite.*` inside JSON, but
 * exposed here as a separate URL with the right Content-Type so a
 * browser or reference manager triggers "import" rather than "display".
 */

const FORMATS = {
  bib: {
    contentType: "application/x-bibtex; charset=utf-8",
    field: "bibtex",
    fileExt: "bib",
  },
  ris: {
    contentType: "application/x-research-info-systems; charset=utf-8",
    field: "ris",
    fileExt: "ris",
  },
  apa: {
    contentType: "text/plain; charset=utf-8",
    field: "apa",
    fileExt: "apa.txt",
  },
  txt: {
    contentType: "text/plain; charset=utf-8",
    field: "plain",
    fileExt: "txt",
  },
} as const;

type Format = keyof typeof FORMATS;

function isFormat(x: string): x is Format {
  return x in FORMATS;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string; format: string }> },
) {
  const r = rateLimit(clientKey(req, "cite"), 60, 60, req);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const { slug, format } = await params;
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }
  if (!isFormat(format)) {
    return NextResponse.json(
      {
        error: "bad_format",
        allowed: Object.keys(FORMATS),
      },
      { status: 400 },
    );
  }

  const bench = await getBenchmark(slug);
  if (!bench || bench.editorialStatus !== "live") {
    return NextResponse.json(
      { error: "unknown_slug", slug },
      { status: 404, headers: { "cache-control": "public, s-maxage=60" } },
    );
  }

  const cfg = FORMATS[format];
  const bundle = citeBundle(bench, SITE.url);
  const body = bundle[cfg.field as keyof typeof bundle];
  const filename = `openchainbench-${slug}.${cfg.fileExt}`;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": cfg.contentType,
      // `attachment` triggers the reference-manager import flow in
      // browsers; `inline` would fight with Firefox+Zotero. Filename
      // exposed as ASCII fallback + UTF-8 (RFC 5987) to survive
      // non-ASCII bench titles. Slug is ASCII-only by SLUG_RE, so
      // filename never needs escaping in practice.
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
      "access-control-allow-origin": "*",
    },
  });
}
