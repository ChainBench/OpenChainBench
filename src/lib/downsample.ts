/**
 * Bucket-mean downsampling for sparkline series. Each kept point is the
 * mean of its bucket, preserving the shape that drove the polyline at
 * full resolution. Shared by the MiniChart renderer (client) and the
 * BenchmarkCardData projection (server) so the hub can ship pre-shrunk
 * series over the RSC wire without changing what the chart draws.
 */
export function downsample(values: number[], target: number): number[] {
  if (values.length <= target) return values;
  const bucketSize = values.length / target;
  const out: number[] = [];
  for (let i = 0; i < target; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    let sum = 0;
    let n = 0;
    for (let j = start; j < end && j < values.length; j++) {
      sum += values[j];
      n++;
    }
    if (n > 0) out.push(sum / n);
  }
  return out;
}

/** Max points a 48-px MiniChart sparkline can usefully render. Series
 *  shipped to hub cards are capped to this at the projection boundary. */
export const MINI_CHART_POINTS = 28;
