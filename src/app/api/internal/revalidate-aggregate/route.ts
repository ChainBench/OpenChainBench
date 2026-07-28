import { timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Worker-driven CDN cache purge for the aggregate bench snapshot.
 *
 * The materialize worker POSTs here after successfully writing a fresh
 * aggregate JSON to the VPS-served static path. This route invalidates
 * the `bench-aggregate` cache tag so the next site request re-fetches
 * the aggregate URL, instead of waiting for the ISR revalidate window.
 *
 * Auth: bearer token in `Authorization` header, `REVALIDATE_TOKEN` env,
 * timing-safe compare. Fails closed when the env is missing.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const secret = (process.env.REVALIDATE_TOKEN ?? "").trim();
  if (!secret) {
    return NextResponse.json(
      { error: "no_secret_configured" },
      { status: 503 },
    );
  }
  const header = (req.headers.get("authorization") ?? "").trim();
  const expected = `Bearer ${secret}`;
  const ok =
    header.length === expected.length &&
    timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  if (!ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Next 16's revalidateTag takes a required cache-profile argument.
  // "default" applies the standard purge semantics for the CDN + ISR
  // cache layers this route is meant to invalidate.
  revalidateTag("bench-aggregate", "default");
  // Also invalidate per-bench caches so answer detail pages (/answers/[slug])
  // and benchmark pages refresh from the same generation as the aggregate
  // surfaces (llms.txt, /api/citable, /answers hub). Without this, per-bench
  // caches run on their 300s TTL clock independently and answer detail pages
  // can serve different values than the hub for up to 5 minutes after a
  // worker publish.
  revalidateTag("benchmarks", "default");
  return NextResponse.json({ revalidated: true, tags: ["bench-aggregate", "benchmarks"] });
}
