import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { fetchPerpCohortFresh } from "@/lib/perp-stats";
import {
  cohortSnapshotConfigured,
  writeCohortSnapshot,
} from "@/lib/cohort-snapshot";

export const runtime = "nodejs";
// No ISR. The cron's whole job is to refresh the cohort blob: a cached
// 200 from a previous run would silently skip the Prom call.
export const dynamic = "force-dynamic";

/**
 * Vercel cron: refresh the /perps hub cohort snapshot in Upstash.
 *
 * Runs every minute (vercel.json crons block). Fetches the cohort straight
 * from Prom (bypassing the snapshot-first reader in fetchPerpCohort so the
 * cron never loops on its own blob) and SETs the result under
 * ocb:cohort:perp-cohort:v1 with a 24 h safety-net TTL.
 *
 * Token-gated by CRON_SECRET (Bearer header). When Upstash creds are
 * missing the route still 200s with `{configured: false}` so the cron
 * schedule keeps working before the integration is provisioned.
 */

function isAuthorized(req: NextRequest): boolean {
  // Trim both sides. The vercel UI / `vercel env add` paste flow has
  // historically appended a trailing newline that produced a constant
  // 401 with no visible reason.
  const secret = (process.env.CRON_SECRET ?? "").trim();
  const header = (req.headers.get("authorization") ?? "").trim();
  if (!secret) {
    // Fail closed in prod, permissive in dev to keep local manual hits
    // working without exporting a fake secret.
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
  let result: Awaited<ReturnType<typeof fetchPerpCohortFresh>>;
  try {
    result = await fetchPerpCohortFresh();
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        stage: "fetch",
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  if (!result) {
    // Prom unreachable or completely empty. Do NOT write null over the
    // existing blob: the reader's stale-tolerance window would surface
    // the null, but we'd rather the reader fall through to its own live
    // path and keep the previous (still-valid-for-now) snapshot until
    // either the cron or a request restores live data.
    return NextResponse.json(
      {
        ok: false,
        stage: "fetch",
        error: "fetchPerpCohortFresh returned null (prom unreachable or empty)",
      },
      { status: 502 },
    );
  }

  try {
    await writeCohortSnapshot("perp-cohort", result);
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
    asOf: result.asOf,
    venueCount: result.venues.length,
    trackedVenues: result.totals.trackedVenues,
    durationMs: Date.now() - startedAt,
  });
}
