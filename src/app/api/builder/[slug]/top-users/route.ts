/**
 * Top-users data source for the per-builder dashboard. Server-side
 * proxy to the feed harness `/top-users/<slug>` endpoint, same
 * Caddy basic_auth as the daily-series proxy.
 *
 * Browser path: GET /api/builder/<slug>/top-users
 *  → reads HL_FEED_URL (optional) + HL_NODE_AUTH env vars
 *  → forwards to <node>/top-users/<slug>
 *  → echoes the harness JSON to the client with a CDN-friendly cache
 *    header so the table-render fan-out collapses on the edge.
 */

import { NextResponse } from "next/server";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isHlBuilderSlug } from "@/lib/hl-builder-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HL_FEED_DEFAULT_URL = "https://hl-archive.openchainbench.com";

type Params = { slug: string };

export async function GET(
  req: Request,
  { params }: { params: Promise<Params> },
) {
  const r = rateLimit(clientKey(req, "hl-top-users"), 60, 60, req);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const { slug } = await params;
  if (!(await isHlBuilderSlug(slug))) {
    return NextResponse.json({ error: "not_a_builder" }, { status: 404 });
  }

  // The feed harness sits behind the VPS Caddy (hl-archive host, basic
  // auth). HL_FEED_URL overrides the host; HL_NODE_AUTH is the existing
  // base64 user:password the same Caddy users accept.
  const nodeUrl = process.env.HL_FEED_URL?.trim() || HL_FEED_DEFAULT_URL;
  const auth = process.env.HL_NODE_AUTH?.trim();
  if (!auth) {
    return NextResponse.json(
      { error: "hl_feed_not_configured" },
      { status: 503 },
    );
  }

  const upstream = `${nodeUrl.replace(/\/$/, "")}/top-users/${encodeURIComponent(slug)}`;
  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "upstream_unreachable", detail: reason.slice(0, 200) },
      { status: 502 },
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `upstream_${res.status}`, detail: body.slice(0, 200) },
      { status: 502 },
    );
  }

  const data = await res.json();
  return NextResponse.json(data, {
    headers: {
      "cache-control": "public, s-maxage=30, stale-while-revalidate=60",
    },
  });
}
