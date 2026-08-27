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
// force-dynamic + explicit Cache-Control: CDN caches via s-maxage without
// generating ISR write entries. revalidateTag("bench-aggregate") from the
// worker has no effect here (route is not ISR), but the CDN's own 60s TTL
// keeps the blob fresh.
export const dynamic = "force-dynamic";

const UPSTREAM = "https://kv.openchainbench.com/aggregate/latest.json";
// Paris VPS → IAD1 with 7.3 MB payload: measured 37-49 s uncompressed.
// With Accept-Encoding:gzip Caddy compresses to ~2.3 MB in ~18 s. Set
// the timeout to 70 s so cold-cache first requests always complete.
const UPSTREAM_TIMEOUT_MS = 70_000;

export async function GET() {
  // Retry once: some Vercel function instances can't reach the Paris VPS
  // (connection refused / reset). A second attempt uses a different
  // outbound connection and typically succeeds. Without retry, a single
  // bad instance poisons the 60s unstable_cache window for loadAggregateFromBlob,
  // forcing all benchmark loads onto the slow Redis fan-out path.
  let lastErr: string = "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    let upstream: Response;
    try {
      upstream = await fetch(UPSTREAM, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: { "Accept-Encoding": "gzip, br" },
        // No cache:"no-store" here: that flag opts the route into
        // dynamic mode and causes Next.js to strip s-maxage from our
        // response headers, breaking Vercel CDN caching. The ISR
        // revalidate=60 above handles freshness instead.
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
        // Vercel CDN caches 60 s + 5 min SWR — aligns with the materialize
        // worker's publish cadence (~60 s). The sitemap and homepage get a
        // warm edge hit after the first request.
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  }

  return new Response(
    JSON.stringify({ error: "upstream fetch failed", detail: lastErr }),
    { status: 502, headers: { "Content-Type": "application/json" } },
  );
}
