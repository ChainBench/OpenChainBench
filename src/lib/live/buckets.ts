import type { Bucket } from "./types";

/**
 * Insert a swap into the incremental bucket store, fill any time gaps
 * with empty buckets so the chart line goes flat (not jumps) during quiet
 * periods, and evict buckets outside the rolling window.
 *
 * Buckets are INCREMENTAL (volume added during the bucket window). The
 * chart computes cumulative at render time. when the window slides
 * forward, the oldest bucket simply disappears and the line re-bases at 0.
 *
 * `bucketMs` and `windowMs` come from the relay snapshot, so this
 * function works for every resolution (10m, 1h, 24h) without hardcoded
 * constants.
 */
export function appendSwapToBuckets(
  prev: Bucket[],
  chainKey: string,
  usd: number,
  nowMs: number,
  bucketMs: number,
  windowMs: number,
): Bucket[] {
  const bucketTs = Math.floor(nowMs / bucketMs) * bucketMs;
  const buckets = [...prev];
  const last = buckets[buckets.length - 1];

  if (last && bucketTs > last.ts + bucketMs) {
    for (let t = last.ts + bucketMs; t < bucketTs; t += bucketMs) {
      buckets.push({ ts: t, perChain: {} });
    }
  }

  if (last && last.ts === bucketTs) {
    const upd = { ts: last.ts, perChain: { ...last.perChain } };
    upd.perChain[chainKey] = (upd.perChain[chainKey] ?? 0) + usd;
    buckets[buckets.length - 1] = upd;
  } else {
    buckets.push({ ts: bucketTs, perChain: { [chainKey]: usd } });
  }

  const cutoff = nowMs - windowMs;
  while (buckets.length > 0 && buckets[0].ts < cutoff) {
    buckets.shift();
  }
  return buckets;
}

/** Sum incremental buckets into a per-chain cumulative map. */
export function cumulativePerChain(buckets: Bucket[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of buckets) {
    for (const k in b.perChain) {
      out[k] = (out[k] ?? 0) + b.perChain[k];
    }
  }
  return out;
}

/** Round up to a clean numeric ceiling for chart Y-axis labels. */
export function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const frac = v / mag;
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return niceFrac * mag;
}
