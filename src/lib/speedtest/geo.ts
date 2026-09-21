/**
 * Geohash helpers for the crowdsourced latency map.
 *
 * Why geohash: aggregation across zoom levels is free. A precision-4
 * hash (~39x20 km cell, city scale, matching IP-geolocation accuracy)
 * rolls up to precision-2 (~1250x625 km, continent scale) by simple
 * string prefix truncation, so one stored resolution serves every zoom.
 */

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Encode lat/lon to a geohash of the given precision (default 4). */
export function geohashEncode(lat: number, lon: number, precision = 4): string {
  let minLat = -90,
    maxLat = 90,
    minLon = -180,
    maxLon = 180;
  let hash = "";
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (minLon + maxLon) / 2;
      if (lon >= mid) {
        ch = (ch << 1) + 1;
        minLon = mid;
      } else {
        ch = ch << 1;
        maxLon = mid;
      }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat >= mid) {
        ch = (ch << 1) + 1;
        minLat = mid;
      } else {
        ch = ch << 1;
        maxLat = mid;
      }
    }
    even = !even;
    bit += 1;
    if (bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

/** Center point of a geohash cell. */
export function geohashCenter(hash: string): { lat: number; lon: number } {
  let minLat = -90,
    maxLat = 90,
    minLon = -180,
    maxLon = 180;
  let even = true;
  for (const c of hash) {
    const idx = BASE32.indexOf(c);
    for (let b = 4; b >= 0; b--) {
      const bit = (idx >> b) & 1;
      if (even) {
        const mid = (minLon + maxLon) / 2;
        if (bit === 1) minLon = mid;
        else maxLon = mid;
      } else {
        const mid = (minLat + maxLat) / 2;
        if (bit === 1) minLat = mid;
        else maxLat = mid;
      }
      even = !even;
    }
  }
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
}

/** Median of a numeric array (NaN on empty). */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Parse a stored latency entry: "unixSeconds:p50" (current format) or
 *  a bare legacy number (ts null). Invalid entries return null. */
export function parseLatEntry(raw: string): { ts: number | null; p50: number } | null {
  const idx = raw.indexOf(":");
  if (idx === -1) {
    const v = Number(raw);
    return Number.isFinite(v) ? { ts: null, p50: v } : null;
  }
  const ts = Number(raw.slice(0, idx));
  const v = Number(raw.slice(idx + 1));
  if (!Number.isFinite(v)) return null;
  return { ts: Number.isFinite(ts) ? ts : null, p50: v };
}

/** Current + previous month keys ("2026-09"), the map's rolling window. */
export function monthKeys(now: Date): [string, string] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const cur = `${y}-${String(m + 1).padStart(2, "0")}`;
  const pd = new Date(Date.UTC(y, m - 1, 1));
  const prev = `${pd.getUTCFullYear()}-${String(pd.getUTCMonth() + 1).padStart(2, "0")}`;
  return [cur, prev];
}
