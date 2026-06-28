/**
 * Reader for the Hyperliquid long-window archive blob.
 *
 * The Go side (hl-archive on Railway) writes `ocb:hl-archive:v1` into
 * Upstash on every flush. This module is the only Next.js entry point
 * that touches that key — every UI/API consumer goes through `getArchive()`
 * so the parse + null-safety logic lives in one place.
 *
 * Failure protocol: every error path returns null. The bench page and
 * the history API then fall back to the live Prom snapshot for short
 * windows, and show a "backfill pending" affordance for long windows.
 * We never surface a Redis or JSON-shape error to the renderer.
 *
 * Credentials follow the same fallback pair as cohort-snapshot.ts so
 * local dev and Vercel work without extra wiring.
 */

import { unstable_cache } from "next/cache";
import type {
  ArchiveSnapshot,
  HlArchiveBuilder,
  HlArchiveDailyPoint,
  HlArchiveWindow,
  HlArchiveWindowTotals,
} from "@/types/hl-archive";
import { HL_ARCHIVE_WINDOWS } from "@/types/hl-archive";

const URL_ENV = ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"] as const;
const TOKEN_ENV = ["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"] as const;

export const HL_ARCHIVE_KEY = "ocb:hl-archive:v1";

function creds(): { url: string; token: string } | null {
  const url = URL_ENV.map((k) => process.env[k]?.trim()).find(Boolean);
  const token = TOKEN_ENV.map((k) => process.env[k]?.trim()).find(Boolean);
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

async function redisGet(key: string, timeoutMs = 3_000): Promise<string | null> {
  const c = creds();
  if (!c) return null;
  const res = await fetch(c.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(["GET", key]),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`hl-archive-store: http ${res.status}`);
  }
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (body.error) throw new Error(`hl-archive-store: ${body.error}`);
  return typeof body.result === "string" ? body.result : null;
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseTotals(raw: unknown): HlArchiveWindowTotals | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isNumber(r.volume_usd) || !isNumber(r.fees_usd) || !isNumber(r.fills)) {
    return null;
  }
  return {
    volume_usd: r.volume_usd,
    fees_usd: r.fees_usd,
    fills: r.fills,
  };
}

function parseDailyPoint(raw: unknown): HlArchiveDailyPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.day !== "string") return null;
  if (!isNumber(r.vol) || !isNumber(r.fees) || !isNumber(r.fills)) return null;
  return { day: r.day, vol: r.vol, fees: r.fees, fills: r.fills };
}

function parseBuilder(raw: unknown): HlArchiveBuilder | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string") return null;
  const windowsRaw = r.windows;
  if (!windowsRaw || typeof windowsRaw !== "object") return null;
  const windows: Partial<Record<HlArchiveWindow, HlArchiveWindowTotals>> = {};
  for (const w of HL_ARCHIVE_WINDOWS) {
    const totals = parseTotals(
      (windowsRaw as Record<string, unknown>)[w],
    );
    if (totals) windows[w] = totals;
  }
  let timeseries_daily: HlArchiveDailyPoint[] | undefined;
  if (Array.isArray(r.timeseries_daily)) {
    timeseries_daily = r.timeseries_daily
      .map(parseDailyPoint)
      .filter((p): p is HlArchiveDailyPoint => p !== null);
  }
  return { name: r.name, windows, timeseries_daily };
}

function parseSnapshot(raw: string): ArchiveSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.updated_at !== "string") return null;
  if (!r.builders || typeof r.builders !== "object") return null;
  const builders: Record<string, HlArchiveBuilder> = {};
  for (const [addr, b] of Object.entries(r.builders as Record<string, unknown>)) {
    const parsedB = parseBuilder(b);
    if (parsedB) builders[addr] = parsedB;
  }
  return { updated_at: r.updated_at, builders };
}

async function getArchiveRaw(): Promise<ArchiveSnapshot | null> {
  try {
    const raw = await redisGet(HL_ARCHIVE_KEY);
    if (!raw) return null;
    return parseSnapshot(raw);
  } catch (err) {
    console.warn(
      `hl-archive read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

const getArchiveCached = unstable_cache(
  getArchiveRaw,
  ["hl-archive-v1"],
  { revalidate: 60, tags: ["hl-archive"] },
);

export async function getArchive(): Promise<ArchiveSnapshot | null> {
  return getArchiveCached();
}

export function hlArchiveConfigured(): boolean {
  return creds() !== null;
}
