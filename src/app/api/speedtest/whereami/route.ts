import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * IP-level position of the requester, from Vercel's edge geo headers.
 * Powers the "Near me" button on /rpc-map without the browser
 * geolocation permission prompt. Nothing is stored; the response is
 * private and uncacheable by design.
 */
export async function GET(req: NextRequest) {
  const h = req.headers;
  let lat = parseFloat(h.get("x-vercel-ip-latitude") ?? "");
  let lon = parseFloat(h.get("x-vercel-ip-longitude") ?? "");
  let city = decodeURIComponent(h.get("x-vercel-ip-city") ?? "");
  let country = h.get("x-vercel-ip-country") ?? "";
  if ((Number.isNaN(lat) || Number.isNaN(lon)) && process.env.NODE_ENV !== "production") {
    lat = 48.86;
    lon = 2.35;
    city = "Paris";
    country = "FR";
  }
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return NextResponse.json({ ok: false }, { status: 202 });
  }
  return NextResponse.json(
    { ok: true, lat, lon, city, country },
    { headers: { "cache-control": "private, no-store" } },
  );
}
