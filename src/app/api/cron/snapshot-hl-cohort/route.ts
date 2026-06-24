import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  fetchHlCohortFresh,
  fetchHlHip3CohortFresh,
} from "@/lib/hl-builder-stats";
import {
  cohortSnapshotConfigured,
  writeCohortSnapshot,
} from "@/lib/cohort-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Vercel cron: refresh the /hyperliquid hub's two cohort snapshots in
 * Upstash. Single endpoint that updates both keys (hl-frontends, hl-hip3)
 * so a single cron entry covers the whole hub.
 *
 * Runs every minute. Bypasses the snapshot-first readers (which would
 * loop back to their own blob); calls the *Fresh helpers directly so the
 * write reflects live Prom state. Token-gated by CRON_SECRET. When the
 * Upstash creds are unset the route 200s with `{configured: false}` so
 * an unprovisioned environment doesn't break the cron schedule.
 *
 * Per-cohort errors are isolated: a Prom miss on HIP-3 doesn't block a
 * fresh frontends write, and vice versa. The response body lists the
 * outcome of each key so the Vercel cron log shows partial recoveries.
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

type KeyOutcome =
  | { key: string; ok: true; asOf: number; rowCount: number }
  | { key: string; ok: false; error: string };

async function refresh<T extends { asOf: number; rows: unknown[] }>(
  key: string,
  fetcher: () => Promise<T | null>,
): Promise<KeyOutcome> {
  let result: T | null;
  try {
    result = await fetcher();
  } catch (err) {
    return {
      key,
      ok: false,
      error: `fetch: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!result) {
    return {
      key,
      ok: false,
      error: "fetch returned null (prom unreachable or empty)",
    };
  }
  try {
    await writeCohortSnapshot(key, result);
  } catch (err) {
    return {
      key,
      ok: false,
      error: `write: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { key, ok: true, asOf: result.asOf, rowCount: result.rows.length };
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
  const [frontends, hip3] = await Promise.all([
    refresh("hl-frontends", fetchHlCohortFresh),
    refresh("hl-hip3", fetchHlHip3CohortFresh),
  ]);

  const okCount = (frontends.ok ? 1 : 0) + (hip3.ok ? 1 : 0);
  return NextResponse.json(
    {
      ok: okCount > 0,
      results: [frontends, hip3],
      durationMs: Date.now() - startedAt,
    },
    { status: okCount === 0 ? 502 : 200 },
  );
}
