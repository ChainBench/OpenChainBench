/**
 * Reader for the perp-volume-history harness (bench 266): one perp
 * notional figure per venue per closed UTC day, backfilled over a year.
 *
 * The harness serves /v1/history on the OCB VPS and mirrors the same
 * document to a static file behind Caddy. The site reads the static
 * URL (cheap, CDN cached) and never talks to the harness process
 * directly. Failure protocol: every error path returns null and the
 * callers hide the module, the way hl-archive-store does.
 */

import { unstable_cache } from "next/cache";

const DEFAULT_URL = "https://kv.openchainbench.com/aggregate/perp-volume/history.json";

/** Venue slugs the harness tracks (mirror of its cohort list). Used to
 *  decide whether a compare pair gets the daily volume hero without a
 *  network read at metadata time. */
export const PERP_VOLUME_COHORT: ReadonlySet<string> = new Set([
  "hyperliquid",
  "hyperliquid-hip3",
  "gmx",
  "gains",
  "aster",
  "lighter",
  "dydx",
  "paradex",
  "extended",
  "orderly",
  "aevo",
]);

export type PerpVolumePoint = { day: string; usd: number };

export type PerpVolumeVenue = {
  slug: string;
  name: string;
  /** Upstream identifier (gmx-squid, gains-backend, hl-info-candles...). */
  source: string;
  /** One line perimeter caveat for footnotes. */
  note?: string;
  /** Ascending by day. */
  days: PerpVolumePoint[];
};

export type PerpVolumeHistory = {
  generatedAt: string;
  lastClosedDay: string;
  venues: PerpVolumeVenue[];
};

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseHistory(raw: unknown): PerpVolumeHistory | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.generated_at !== "string" || typeof r.last_closed_day !== "string") return null;
  if (!Array.isArray(r.venues)) return null;
  const venues: PerpVolumeVenue[] = [];
  for (const v of r.venues) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (typeof o.slug !== "string" || typeof o.name !== "string") continue;
    const days: PerpVolumePoint[] = [];
    if (Array.isArray(o.days)) {
      for (const p of o.days) {
        if (!p || typeof p !== "object") continue;
        const q = p as Record<string, unknown>;
        if (typeof q.day === "string" && isNumber(q.usd)) days.push({ day: q.day, usd: q.usd });
      }
    }
    days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    venues.push({
      slug: o.slug,
      name: o.name,
      source: typeof o.source === "string" ? o.source : "",
      note: typeof o.note === "string" ? o.note : undefined,
      days,
    });
  }
  return { generatedAt: r.generated_at, lastClosedDay: r.last_closed_day, venues };
}

async function fetchHistoryRaw(): Promise<PerpVolumeHistory | null> {
  const url = process.env.PERP_VOLUME_HISTORY_URL?.trim() || DEFAULT_URL;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6_000),
      // Data-cache entry like the bench blobs: a no-store fetch inside an
      // ISR page can flip the whole route dynamic (see #2343).
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return parseHistory(await res.json());
  } catch (err) {
    console.warn(
      `perp-volume-history read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

const getHistoryCached = unstable_cache(fetchHistoryRaw, ["perp-volume-history-v1"], {
  revalidate: 300,
  tags: ["perp-volume-history"],
});

export async function getPerpVolumeHistory(): Promise<PerpVolumeHistory | null> {
  return getHistoryCached();
}

export function findVenue(
  history: PerpVolumeHistory,
  slug: string,
): PerpVolumeVenue | null {
  return history.venues.find((v) => v.slug === slug) ?? null;
}

// ---------------------------------------------------------------------
// Pure helpers (also used by tests)
// ---------------------------------------------------------------------

const DAY_MS = 86_400_000;

export function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Sum of the window [end-days+1, end]; null when any day is missing. */
export function windowSum(
  venue: PerpVolumeVenue,
  end: string,
  days: number,
): number | null {
  const start = shiftDay(end, -(days - 1));
  const map = new Map(venue.days.map((p) => [p.day, p.usd]));
  let total = 0;
  for (let d = start; d <= end; d = shiftDay(d, 1)) {
    const v = map.get(d);
    if (v === undefined) return null;
    total += v;
  }
  return total;
}

export type HeadToHeadDay = {
  day: string;
  a: number | null;
  b: number | null;
  /** "a" | "b" when both present and unequal, null otherwise. */
  lead: "a" | "b" | null;
};

export type HeadToHead = {
  /** Last day both venues have closed. */
  asOf: string;
  days: HeadToHeadDay[];
  window: Record<"1d" | "7d" | "30d", { a: number | null; b: number | null }>;
  /** Days in the last 30 where each side led (both present). */
  daysLed30: { a: number; b: number };
  /** Current consecutive-day lead ending on asOf. */
  streak: { side: "a" | "b" | null; days: number };
  /** First day of the current streak, when there is one. */
  streakSince: string | null;
  /** Days in the last 90 where each side led. */
  daysLed90: { a: number; b: number };
};

/**
 * Head to head on the days both venues have closed, over the last
 * `span` days. asOf is the last day both sides hold, so a venue that
 * lags a day never shows as zero against a finished day.
 */
export function headToHead(
  a: PerpVolumeVenue,
  b: PerpVolumeVenue,
  span = 90,
): HeadToHead | null {
  const ma = new Map(a.days.map((p) => [p.day, p.usd]));
  const mb = new Map(b.days.map((p) => [p.day, p.usd]));
  const lastA = a.days.at(-1)?.day;
  const lastB = b.days.at(-1)?.day;
  if (!lastA || !lastB) return null;
  const asOf = lastA < lastB ? lastA : lastB;
  const days: HeadToHeadDay[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const day = shiftDay(asOf, -i);
    const va = ma.get(day) ?? null;
    const vb = mb.get(day) ?? null;
    let lead: "a" | "b" | null = null;
    if (va !== null && vb !== null && va !== vb) lead = va > vb ? "a" : "b";
    days.push({ day, a: va, b: vb, lead });
  }
  const win = (n: number) => ({ a: windowSum(a, asOf, n), b: windowSum(b, asOf, n) });
  const count = (n: number) => {
    const slice = days.slice(-n);
    return {
      a: slice.filter((d) => d.lead === "a").length,
      b: slice.filter((d) => d.lead === "b").length,
    };
  };
  let streakSide: "a" | "b" | null = days.at(-1)?.lead ?? null;
  let streak = 0;
  let streakSince: string | null = null;
  if (streakSide) {
    for (let i = days.length - 1; i >= 0 && days[i].lead === streakSide; i--) {
      streak++;
      streakSince = days[i].day;
    }
  } else {
    streakSide = null;
  }
  return {
    asOf,
    days,
    window: { "1d": win(1), "7d": win(7), "30d": win(30) },
    daysLed30: count(30),
    daysLed90: count(90),
    streak: { side: streakSide, days: streak },
    streakSince,
  };
}

/** $1.23B / $456M / $78.9K style, for KPI tiles. */
export function fmtUsdCompact(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "n/a";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

export type WeeklyRatioPoint = {
  /** First and last day of the 7-day window. */
  start: string;
  end: string;
  a: number | null;
  b: number | null;
  /** a / b in percent, null when either window is incomplete or b is 0. */
  ratioPct: number | null;
};

export type WeeklyRatio = {
  points: WeeklyRatioPoint[];
  /** Median of the non-null ratios shown. */
  medianPct: number | null;
};

/**
 * A ÷ B on seven-day windows ending on asOf, tiled back with no gap
 * (oldest first). The last window is exactly the compare hero's 7d
 * figure, so the chart and the tiles never name two different weeks.
 * Calendar weeks are deliberately not used: the latest point must end
 * on the last closed day, not on the previous Sunday.
 */
export function weeklyRatio(
  a: PerpVolumeVenue,
  b: PerpVolumeVenue,
  asOf: string,
  count = 16,
): WeeklyRatio {
  const points: WeeklyRatioPoint[] = [];
  let end = asOf;
  for (let i = 0; i < count; i++) {
    const start = shiftDay(end, -6);
    const va = windowSum(a, end, 7);
    const vb = windowSum(b, end, 7);
    points.push({
      start,
      end,
      a: va,
      b: vb,
      ratioPct: va !== null && vb !== null && vb > 0 ? (va / vb) * 100 : null,
    });
    end = shiftDay(end, -7);
  }
  points.reverse();
  const ratios = points
    .map((p) => p.ratioPct)
    .filter((r): r is number => r !== null)
    .sort((x, y) => x - y);
  let medianPct: number | null = null;
  if (ratios.length > 0) {
    const mid = Math.floor(ratios.length / 2);
    medianPct = ratios.length % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  }
  return { points, medianPct };
}
