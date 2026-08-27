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
