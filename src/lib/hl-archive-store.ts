/**
 * Reader for the Hyperliquid long-window archive blob.
 *
 * Reads directly from the hl-archive Go service on Railway via its
 * public HTTPS API. We used to go through Upstash, but the shared
 * free-tier KV hit its 500k/day request cap and pushes silently
 * failed; the Railway service already exposes /v1/aggregates with
 * the exact payload shape and lives on the same fly DuckDB, so a
 * direct read removes one moving part. The Next.js `unstable_cache`
 * wrapper still keeps the per-region request load to one call per
 * 60s, which is what made the Upstash hop interesting in the first
 * place.
 *
 * Failure protocol: every error path returns null. The bench page
 * and the history API fall back to the live Prom snapshot for short
 * windows and show a "backfill pending" affordance for long windows.
 * We never surface a network error to the renderer.
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

const URL_ENV = ["HL_ARCHIVE_API_URL"] as const;
const KEY_ENV = ["HL_ARCHIVE_API_KEY"] as const;

// Kept as the cache key suffix (was the Upstash key name). The constant
// is exported because the history API route uses it as the
// `unstable_cache` tag bump anchor when the upstream shape changes.
export const HL_ARCHIVE_KEY = "ocb:hl-archive:v1";

function creds(): { url: string; key: string } | null {
  const url = URL_ENV.map((k) => process.env[k]?.trim()).find(Boolean);
  const key = KEY_ENV.map((k) => process.env[k]?.trim()).find(Boolean);
  return url && key ? { url: url.replace(/\/+$/, ""), key } : null;
}

async function fetchAggregates(timeoutMs = 5_000): Promise<string | null> {
  const c = creds();
  if (!c) return null;
  const res = await fetch(`${c.url}/v1/aggregates?window=all`, {
    method: "GET",
    headers: { "X-API-Key": c.key },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`hl-archive-store: http ${res.status}`);
  }
  return await res.text();
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
  const out: HlArchiveWindowTotals = {
    volume_usd: r.volume_usd,
    fees_usd: r.fees_usd,
    fills: r.fills,
  };
  if (isNumber(r.users)) out.users = r.users;
  return out;
}

function parseDailyPoint(raw: unknown): HlArchiveDailyPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.day !== "string") return null;
  if (!isNumber(r.vol) || !isNumber(r.fees) || !isNumber(r.fills)) return null;
  const out: HlArchiveDailyPoint = {
    day: r.day,
    vol: r.vol,
    fees: r.fees,
    fills: r.fills,
  };
  if (isNumber(r.users)) out.users = r.users;
  return out;
}

function parseBuilder(raw: unknown): HlArchiveBuilder | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string") return null;
  const slug = typeof r.slug === "string" ? r.slug : "";
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
  return { slug, name: r.name, windows, timeseries_daily };
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
    const raw = await fetchAggregates();
    if (!raw) return null;
    return parseSnapshot(raw);
  } catch (err) {
    console.warn(
      `hl-archive read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// Bump the key when the wire shape changes (e.g. new `users` field on
// TimePoint/WindowAgg) so stale in-memory Next.js caches don't keep
// serving snapshots with missing fields after a rollout.
const getArchiveCached = unstable_cache(
  getArchiveRaw,
  ["hl-archive-v2-users"],
  { revalidate: 60, tags: ["hl-archive"] },
);

export async function getArchive(): Promise<ArchiveSnapshot | null> {
  return getArchiveCached();
}

/** Returns the archive entry matching `slug`, or null if unknown. The
 *  archive map is keyed by builder address, so we linear-scan the
 *  ~100 rows once per hit — trivially cheap, and the caller wrapping
 *  a per-slug route already hits `unstable_cache` upstream. */
export async function getArchiveBuilderBySlug(
  slug: string,
): Promise<HlArchiveBuilder | null> {
  const snap = await getArchive();
  if (!snap) return null;
  for (const b of Object.values(snap.builders)) {
    if (b.slug === slug) return b;
  }
  return null;
}

export function hlArchiveConfigured(): boolean {
  return creds() !== null;
}
