/**
 * Reader for the Hyperliquid trader-leaderboard audit snapshot.
 *
 * The `hl-archive traders` collector writes one raw JSON blob per run
 * under `ocb:hl-traders:v1`. Nothing here falls back to a live fetch:
 * the source blob is ~39 MB and auditing it is the collector's job, so a
 * missing snapshot has to surface as "no reading yet" on the page rather
 * than as zeros, which would publish as a measurement.
 */

import { redisCommand } from "@/lib/cohort-snapshot";
import type { HlTradersSnapshot } from "@/types/hl-traders";

const KEY = "ocb:hl-traders:v1";

/**
 * Hours after which the snapshot is too old to present as current. The
 * collector runs daily, so one missed run is tolerable and two are not.
 * Matches the `STALE_AFTER_HOURS` convention used for bench data.
 */
export const HL_TRADERS_STALE_AFTER_HOURS = 48;

export type HlTradersRead = {
  snapshot: HlTradersSnapshot;
  ageHours: number;
  stale: boolean;
};

/** Narrow an unknown blob to the snapshot shape. */
function isSnapshot(v: unknown): v is HlTradersSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.updated_at === "string" &&
    typeof o.integrity === "object" &&
    o.integrity !== null &&
    Array.isArray(o.top)
  );
}

/**
 * Fetch the snapshot. Returns null when Upstash is unconfigured, the key
 * is absent, or the payload does not parse. Never throws: the page
 * renders an explicit empty state instead of a 500.
 */
export async function fetchHlTraders(): Promise<HlTradersRead | null> {
  let raw: unknown;
  try {
    raw = await redisCommand(["GET", KEY], 6_000);
  } catch {
    return null;
  }
  if (typeof raw !== "string" || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isSnapshot(parsed)) return null;

  const ts = Date.parse(parsed.updated_at);
  const ageHours = Number.isFinite(ts)
    ? (Date.now() - ts) / 3_600_000
    : Number.POSITIVE_INFINITY;

  return {
    snapshot: parsed,
    ageHours,
    stale: ageHours > HL_TRADERS_STALE_AFTER_HOURS,
  };
}
