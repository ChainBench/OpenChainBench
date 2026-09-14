import { NextResponse } from "next/server";
import { buildSearchIndex } from "@/lib/search/buildIndex";

/**
 * Search corpus for the Cmd+K dialog, fetched by the client on demand.
 *
 * This used to be built in the root layout and passed as props to the
 * SearchProvider, which serialized all ~880 entries into the HTML of
 * every page: 278 KB raw / 57 KB gzipped, 63 % of a bench page, sent
 * on every request including the crawler traffic that never opens the
 * dialog. Fast Data Transfer was the largest cost line on the Vercel
 * bill because of it. Served here as an ISR route instead: one CDN
 * object, fetched only when someone hovers or opens search.
 *
 * No request data is read so the route stays static and the CDN can
 * hold it for the full revalidate window.
 */
export const runtime = "nodejs";
export const revalidate = 3600;

export async function GET() {
  const items = await buildSearchIndex();
  return NextResponse.json(
    { ok: true, count: items.length, items },
    {
      headers: {
        "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
        "access-control-allow-origin": "*",
      },
    },
  );
}
