// Vercel-edge proxy for the worker's slim sitemap blob, the same shape of
// transport as /api/aggregate.
//
// UNFILTERED BY DESIGN, for the same reason and with the same warning: it
// serves the blob verbatim, so on production it lists every dev-only bench.
// sitemap-blob.ts:4 points every Vercel deployment at this route on the
// production domain, staging included, and staging is where those benches
// render. Filtering on VERCEL_ENV here would strip them from the staging
// sitemap. The gate that matters is in src/lib/sitemap-builder.ts, which drops
// them per deployment; sitemap.xml on production is correct and carries none
// of them.
export const runtime = "nodejs";
export const revalidate = 3600;

const UPSTREAM = "https://kv.openchainbench.com/aggregate/sitemap.json";
const UPSTREAM_TIMEOUT_MS = 15_000;

export async function GET() {
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    let upstream: Response;
    try {
      upstream = await fetch(UPSTREAM, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: { "Accept-Encoding": "gzip, br" },
      });
    } catch (err) {
      lastErr = String(err);
      continue;
    }
    if (!upstream.ok) {
      lastErr = `status ${upstream.status}`;
      continue;
    }
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  }
  return new Response(
    JSON.stringify({ error: "upstream fetch failed", detail: lastErr }),
    { status: 502, headers: { "Content-Type": "application/json" } },
  );
}
