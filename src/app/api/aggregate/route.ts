// Vercel-edge CDN proxy for the aggregate blob.
//
// kv.openchainbench.com/aggregate/latest.json lives on the Paris VPS
// (no CDN). Vercel functions run in IAD1 (US East) and were timing out
// on the 7.5 MB payload at the old 8 s limit. This route re-exposes the
// blob through Vercel's own CDN: the first request fetches from VPS
// (slow), Vercel caches the response at IAD1's edge for 60 s, all
// subsequent calls within that window cost ~1 ms instead of ~4 s.
//
// aggregate-blob.ts can point AGGREGATE_BLOB_URL at this route instead
// of kv.openchainbench.com to get near-zero latency from any Vercel
// function in the same region.
export const runtime = "nodejs";

const UPSTREAM = "https://kv.openchainbench.com/aggregate/latest.json";
const UPSTREAM_TIMEOUT_MS = 25_000;

export async function GET() {
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { "Accept-Encoding": "gzip, br" },
      cache: "no-store",
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "upstream fetch failed", detail: String(err) }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!upstream.ok) {
    return new Response(
      JSON.stringify({ error: "upstream error", status: upstream.status }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Vercel CDN caches 60 s + 5 min SWR — aligns with the materialize
      // worker's publish cadence (~60 s). The sitemap and homepage get a
      // warm edge hit after the first request.
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
