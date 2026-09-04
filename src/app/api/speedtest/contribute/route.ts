import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { redisPipeline, storeConfigured } from "@/lib/materialize/store";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { geohashEncode, monthKeys } from "@/lib/speedtest/geo";
import { RPC_DIRECTORY } from "@/lib/speedtest/rpc-directory";

export const runtime = "nodejs";

/**
 * Anonymous crowdsourced contribution from the browser speed test.
 *
 * Privacy contract (mirrors the copy on /speedtest-rpc):
 *  - the client sends provider SLUGS only, never URLs and never keys;
 *  - geolocation comes from Vercel's IP headers server-side, rounded to
 *    a ~39 km geohash cell; the IP itself is never stored (a salted
 *    daily hash is used transiently for per-cell caps and expires in
 *    24 h);
 *  - everything lands in monthly aggregation buckets with a 90-day TTL.
 *
 * Poisoning posture: per-IP rate limit, per-(cell,provider,source)
 * daily cap, bounded reservoirs (last 24 readings per cell), medians at
 * read time. Volume cannot buy map weight.
 */

// Directory slugs + keyed-provider families the client may report.
const KEYED_FAMILIES = ["alchemy", "infura", "quicknode", "chainstack", "ankr", "helius"];
const KNOWN_SLUGS = new Set<string>(KEYED_FAMILIES);
const KNOWN_CHAINS = new Set<string>();
for (const c of RPC_DIRECTORY) {
  KNOWN_CHAINS.add(c.slug);
  for (const e of c.endpoints) KNOWN_SLUGS.add(e.slug);
}

const MAX_ENTRIES = 8;
const RESERVOIR = 24;
const CELL_DAILY_CAP = 6;
const TTL_SEC = 90 * 24 * 3600;

type Entry = { slug: string; p50: number; n: number };

function parseBody(raw: unknown): { chain: string; entries: Entry[] } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as { chain?: unknown; entries?: unknown };
  if (typeof b.chain !== "string" || !KNOWN_CHAINS.has(b.chain)) return null;
  if (!Array.isArray(b.entries) || b.entries.length === 0) return null;
  const entries: Entry[] = [];
  for (const e of b.entries.slice(0, MAX_ENTRIES)) {
    if (typeof e !== "object" || e === null) continue;
    const { slug, p50, n } = e as { slug?: unknown; p50?: unknown; n?: unknown };
    if (typeof slug !== "string" || !KNOWN_SLUGS.has(slug)) continue;
    if (typeof p50 !== "number" || !Number.isFinite(p50)) continue;
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    // Sanity clamps: sub-millisecond readings are below browser fetch
    // overhead (fabricated), >10 s is not a usable latency sample.
    if (p50 < 1 || p50 > 10_000) continue;
    if (n < 3 || n > 500) continue;
    entries.push({ slug, p50: Math.round(p50 * 10) / 10, n: Math.round(n) });
  }
  return entries.length > 0 ? { chain: b.chain, entries } : null;
}

export async function POST(req: NextRequest) {
  if (!storeConfigured()) {
    return NextResponse.json({ ok: false, reason: "store_off" }, { status: 503 });
  }
  const rl = rateLimit(clientKey(req, "st-contribute"), 6, 60, req);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad_json" }, { status: 400 });
  }
  const parsed = parseBody(body);
  if (!parsed) {
    return NextResponse.json({ ok: false, reason: "bad_payload" }, { status: 400 });
  }

  // Server-side IP geolocation from Vercel's edge headers. City-level
  // accuracy, which matches the precision-4 cell size. No geo, no map
  // point (dev fallback keeps local testing possible).
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
    return NextResponse.json({ ok: false, reason: "no_geo" }, { status: 202 });
  }
  const gh = geohashEncode(lat, lon, 4);
  const [ym] = monthKeys(new Date());
  const day = new Date().toISOString().slice(0, 10);

  // Transient per-source key: sha256(ip + day), truncated. Rotates
  // daily, expires in 24 h, cannot be joined across days.
  const ip = clientKey(req, "").split("|")[0] ?? "anon";
  const src = createHash("sha256").update(`${ip}:${day}`).digest("hex").slice(0, 12);

  // Daily cap check per (cell, source) before writing anything.
  const capKey = `stm:cap:${day}:${gh}:${src}`;
  const [capCount] = (await redisPipeline([
    ["INCR", capKey],
    ["EXPIRE", capKey, 86_400],
  ])) as [number, unknown];
  if (capCount > CELL_DAILY_CAP) {
    return NextResponse.json({ ok: true, capped: true });
  }

  const cmds: (string | number)[][] = [];
  // Cell metadata (first writer wins; coordinates rounded to ~1 km).
  cmds.push(["HSETNX", `stm:meta:${gh}`, "city", city || "Unknown"]);
  cmds.push(["HSETNX", `stm:meta:${gh}`, "country", country || "??"]);
  cmds.push(["HSETNX", `stm:meta:${gh}`, "lat", Math.round(lat * 100) / 100]);
  cmds.push(["HSETNX", `stm:meta:${gh}`, "lon", Math.round(lon * 100) / 100]);
  cmds.push(["EXPIRE", `stm:meta:${gh}`, TTL_SEC]);
  for (const e of parsed.entries) {
    const pair = `${gh}:${e.slug}`;
    const latKey = `stm:lat:${ym}:${gh}:${parsed.chain}:${e.slug}`;
    cmds.push(["SADD", `stm:idx:${ym}:${parsed.chain}`, pair]);
    cmds.push(["LPUSH", latKey, e.p50]);
    cmds.push(["LTRIM", latKey, 0, RESERVOIR - 1]);
    cmds.push(["EXPIRE", latKey, TTL_SEC]);
  }
  cmds.push(["EXPIRE", `stm:idx:${ym}:${parsed.chain}`, TTL_SEC]);
  cmds.push(["INCR", "stm:total"]);
  await redisPipeline(cmds);

  return NextResponse.json({ ok: true });
}
