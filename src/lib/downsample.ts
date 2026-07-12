/**
 * Bucket-mean downsampling for sparkline series. Each kept point is the
 * mean of its bucket, preserving the shape that drove the polyline at
 * full resolution. Shared by the MiniChart renderer (client) and the
 * BenchmarkCardData projection (server) so the hub can ship pre-shrunk
 * series over the RSC wire without changing what the chart draws.
 */
export function downsample(values: (number | null)[], target: number): number[] {
  // Dense series carry nulls for empty Prom buckets. Sparkline-scale
  // charts cannot usefully render a gap, so nulls are dropped: within a
  // bucket the mean is taken over real samples only, and buckets with
  // no sample at all are omitted (same behavior the pre-null code had
  // for empty buckets).
  if (values.length <= target) {
    return values.filter((v): v is number => v != null);
  }
  const bucketSize = values.length / target;
  const out: number[] = [];
  for (let i = 0; i < target; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    let sum = 0;
    let n = 0;
    for (let j = start; j < end && j < values.length; j++) {
      const v = values[j];
      if (v == null) continue;
      sum += v;
      n++;
    }
    if (n > 0) out.push(sum / n);
  }
  return out;
}

/** Max points a 48-px MiniChart sparkline can usefully render. Series
 *  shipped to hub cards are capped to this at the projection boundary. */
export const MINI_CHART_POINTS = 28;
