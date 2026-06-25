import { NextResponse } from "next/server";
import { readCohortSnapshot } from "@/lib/cohort-snapshot";
import {
  buildFeaturedLeaders,
  type FeaturedLeadersBlob,
} from "@/lib/search-featured";

export const runtime = "nodejs";
// 60 s revalidate so even a cold edge cache only needs one round-trip
// per minute per region. The cron rewrites the underlying KV blob on the
// same cadence; stale-while-revalidate keeps every other request hot.
export const revalidate = 60;

/**
 * Slim payload feeding the header search dialog's "Live leaders" +
 * "Trending" sections. Reads through Upstash KV first (cron-warmed,
 * ~5 ms response) and falls through to a live build only on cold KV
 * (deploy minute zero, missing creds, or worker outage).
 *
 * The previous implementation called /api/citable which assembled the
 * full ~30-bench citable index (~50 KB) on every dialog open. This
 * route returns the 12-card subset (~2 KB) the dialog actually needs.
 */
export async function GET() {
  const snap = await readCohortSnapshot<FeaturedLeadersBlob>("search-featured");
  if (snap?.data) {
    return NextResponse.json(
      { ok: true, source: "kv", ageMs: snap.ageMs, ...snap.data },
      {
        headers: {
          "cache-control":
            "public, s-maxage=60, stale-while-revalidate=300",
          "access-control-allow-origin": "*",
        },
      },
    );
  }

  // Cold-fall-through: build live. Slower (one full benchmark assembly)
  // but never blocks the dialog if the cron hasn't run yet or Upstash is
  // unreachable. The cron will heal this on its next tick.
  try {
    const blob = await buildFeaturedLeaders();
    return NextResponse.json(
      { ok: true, source: "live", ageMs: 0, ...blob },
      {
        headers: {
          "cache-control":
            "public, s-maxage=60, stale-while-revalidate=300",
          "access-control-allow-origin": "*",
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        featured: [],
        trending: [],
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
