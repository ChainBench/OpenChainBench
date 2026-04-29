/**
 * Minimal Prometheus HTTP API client.
 * Docs: https://prometheus.io/docs/prometheus/latest/querying/api/
 */

export type PromVector = { metric: Record<string, string>; value: [number, string] };
export type PromMatrix = { metric: Record<string, string>; values: [number, string][] };
export type PromInstantResult =
  | { resultType: "vector"; result: PromVector[] }
  | { resultType: "scalar"; result: [number, string] }
  | { resultType: "matrix"; result: PromMatrix[] };

type PromEnvelope<T> =
  | { status: "success"; data: T; warnings?: string[] }
  | { status: "error"; errorType: string; error: string };

/** Default timeout for Prometheus queries — keep short, build time is finite. */
const DEFAULT_TIMEOUT_MS = 4_000;

export class Prometheus {
  constructor(public readonly baseUrl: string) {
    if (!baseUrl) throw new Error("Prometheus baseUrl is required");
  }

  /** GET /api/v1/query — instant query at evaluation time `now`. */
  async query(promql: string, signal?: AbortSignal): Promise<PromInstantResult> {
    const url = new URL("/api/v1/query", this.baseUrl);
    url.searchParams.set("query", promql);
    return this.fetchEnvelope<PromInstantResult>(url, signal);
  }

  /** GET /api/v1/query_range — range query for series/sparklines. */
  async queryRange(
    promql: string,
    start: Date,
    end: Date,
    stepSeconds: number,
    signal?: AbortSignal
  ): Promise<{ resultType: "matrix"; result: PromMatrix[] }> {
    const url = new URL("/api/v1/query_range", this.baseUrl);
    url.searchParams.set("query", promql);
    url.searchParams.set("start", String(start.getTime() / 1000));
    url.searchParams.set("end", String(end.getTime() / 1000));
    url.searchParams.set("step", String(stepSeconds));
    return this.fetchEnvelope(url, signal) as Promise<{
      resultType: "matrix";
      result: PromMatrix[];
    }>;
  }

  /** Convenience: scalar number from any instant query, or null if empty/error. */
  async scalar(promql: string): Promise<number | null> {
    try {
      const res = await this.query(promql);
      if (res.resultType === "scalar") return Number(res.result[1]);
      if (res.resultType === "vector" && res.result.length > 0) {
        const v = Number(res.result[0].value[1]);
        return Number.isFinite(v) ? v : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Convenience: an evenly-spaced numeric series for the last `windowSec` seconds.
   * Default 72 points = 20-min resolution over a 24h window.
   *
   * If the query returns multiple series (e.g. one per route × token × region
   * for the same provider), the values are averaged at each timestamp so the
   * caller gets a single coherent line. Without this, providers with broader
   * coverage would silently drop because we used to keep only the first
   * matching series and that one was often sparse / NaN. */
  async series(promql: string, windowSec: number, points = 72): Promise<number[] | null> {
    try {
      const end = new Date();
      const start = new Date(end.getTime() - windowSec * 1000);
      const step = Math.max(1, Math.floor(windowSec / points));
      const res = await this.queryRange(promql, start, end, step);
      if (res.result.length === 0) return null;

      // Build a timestamp → [values] map across all returned series.
      const buckets = new Map<number, number[]>();
      for (const series of res.result) {
        for (const [ts, raw] of series.values) {
          const v = Number(raw);
          if (!Number.isFinite(v)) continue;
          const list = buckets.get(ts) ?? [];
          list.push(v);
          buckets.set(ts, list);
        }
      }

      // Average values per timestamp, ordered chronologically.
      const ordered = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
      const out = ordered.map(([, vs]) => vs.reduce((s, v) => s + v, 0) / vs.length);
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  }

  private async fetchEnvelope<T>(url: URL, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const merged = signal ? mergeSignals(signal, controller.signal) : controller.signal;
      const res = await fetch(url, {
        signal: merged,
        // Cache at the platform level — pages call us through ISR.
        next: { revalidate: 60 },
      });
      if (!res.ok) {
        throw new Error(`prometheus: ${res.status} ${res.statusText}`);
      }
      const json = (await res.json()) as PromEnvelope<T>;
      if (json.status === "error") {
        throw new Error(`prometheus: ${json.errorType}: ${json.error}`);
      }
      return json.data;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const c = new AbortController();
  const onAbort = () => c.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return c.signal;
}
