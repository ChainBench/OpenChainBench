/**
 * Per-builder long-window Performance chart data source. Companion to
 * `/daily-series` which serves only the last 30 days from the live
 * hl-node harness in-memory ring: this route reaches into the
 * hl-archive Go service (DuckDB-backed, ≈11 months of daily
 * aggregates) and returns the same wire shape as `/daily-series` so
 * the chart client can swap sources based on the user's range picker
 * without a second parser.
 *
 * Browser path: GET /api/builder/<slug>/daily-history?days=365
 *   → getArchive() (unstable_cache 60 s) reads /v1/aggregates?window=all
 *     from hl-archive over HTTP + X-API-Key
 *   → we look up the slug in the returned map (keyed by 0x address, so
 *     the payload's own `slug` field is our index) and slice the last
 *     N days off the tail
 *   → reshape { day, vol, fees, fills } → { date, day_unix, fees_usd,
 *     volume_usd, users } so the client renderer only knows one shape
 *
 * `users` field is not persisted per-day in the archive schema (the
 * DuckDB table stores unique_users per (day, builder, asset) tuple but
 * we don't fan out to sum here — cardinality gets hairy for a route
 * whose only consumer is the chart). We emit 0 so the client tolerates
 * it; the 30d live range still shows real users, and the long-window
 * chart intentionally focuses on revenue/volume anyway.
 */

import { NextResponse } from "next/server";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isHlBuilderSlug } from "@/lib/hl-builder-stats";
import { getArchiveBuilderBySlug } from "@/lib/hl-archive-store";

export const runtime = "nodejs";
export const revalidate = 60;

type Params = { slug: string };

const DEFAULT_DAYS = 365;
const MAX_DAYS = 400;

type WirePoint = {
  date: string;
  day_unix: number;
  fees_usd: number;
  volume_usd: number;
  users: number;
};

export async function GET(
  req: Request,
  { params }: { params: Promise<Params> },
) {
  const r = rateLimit(clientKey(req, "hl-daily-history"), 60, 60, req);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const { slug } = await params;
  if (!(await isHlBuilderSlug(slug))) {
    return NextResponse.json({ error: "not_a_builder" }, { status: 404 });
  }

  const url = new URL(req.url);
  const daysRaw = url.searchParams.get("days");
  let days = DEFAULT_DAYS;
  if (daysRaw !== null) {
    const parsed = Number.parseInt(daysRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json({ error: "bad_days" }, { status: 400 });
    }
    days = Math.min(parsed, MAX_DAYS);
  }

  const builder = await getArchiveBuilderBySlug(slug);
  if (!builder) {
    return NextResponse.json(
      { error: "archive_pending" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const raw = builder.timeseries_daily ?? [];
  const tail = raw.slice(Math.max(0, raw.length - days));
  const points: WirePoint[] = tail.map((p) => ({
    date: p.day,
    day_unix: Math.floor(new Date(`${p.day}T00:00:00Z`).getTime() / 1000),
    fees_usd: p.fees,
    volume_usd: p.vol,
    users: p.users ?? 0,
  }));

  const asOf =
    points.length > 0
      ? points[points.length - 1].day_unix + 86400
      : Math.floor(Date.now() / 1000);

  return NextResponse.json(
    {
      builder: slug,
      as_of: asOf,
      days: points.length,
      points,
    },
    {
      headers: {
        "cache-control": "public, s-maxage=60, stale-while-revalidate=600",
      },
    },
  );
}
