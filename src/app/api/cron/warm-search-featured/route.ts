import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  cohortSnapshotConfigured,
  writeCohortSnapshot,
} from "@/lib/cohort-snapshot";
import { buildFeaturedLeaders } from "@/lib/search-featured";

export const runtime = "nodejs";
// No ISR — the cron's whole job is to refresh the blob. A cached 200 from
// a previous run would silently skip the rebuild.
export const dynamic = "force-dynamic";

/**
 * Vercel cron: refresh the search dialog's "Live leaders" + "Trending"
 * blob in Upstash. Runs every minute (vercel.json crons block).
 *
 * Why a dedicated blob: the search dialog used to fetch /api/citable on
 * every open (the full ~30-bench citable index, ~50 KB, plus all the
 * assembly cost server-side). Now the cron pre-computes the 12-card
 * subset the dialog actually needs (~2 KB), the public endpoint becomes
 * one KV GET, and the dialog opens with data already prefetched at page
 * load.
 *
 * Same token gate + soft-no-op pattern as snapshot-perp-cohort.
 */

function isAuthorized(req: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  const header = (req.headers.get("authorization") ?? "").trim();
  if (!secret) {
    return process.env.NODE_ENV !== "production";
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(header);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!cohortSnapshotConfigured()) {
    return NextResponse.json(
      {
        ok: true,
        configured: false,
        message:
          "cohort snapshot store not configured (KV_REST_API_URL / UPSTASH_REDIS_REST_URL absent)",
      },
      { status: 200 },
    );
  }

  const startedAt = Date.now();
  let blob;
  try {
    blob = await buildFeaturedLeaders();
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        stage: "build",
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  try {
    await writeCohortSnapshot("search-featured", blob);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        stage: "write",
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    featuredCount: blob.featured.length,
    trendingCount: blob.trending.length,
    durationMs: Date.now() - startedAt,
  });
}
