/**
 * Minimal Prometheus HTTP API client.
 * Docs: https://prometheus.io/docs/prometheus/latest/querying/api/
 */

import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export type PromVector = { metric: Record<string, string>; value: [number, string] };
export type PromMatrix = { metric: Record<string, string>; values: [number, string][] };
export type PromInstantResult =
  | { resultType: "vector"; result: PromVector[] }
  | { resultType: "scalar"; result: [number, string] }
  | { resultType: "matrix"; result: PromMatrix[] };

type PromEnvelope<T> =
  | { status: "success"; data: T; warnings?: string[] }
  | { status: "error"; errorType: string; error: string };

/** Default timeout for Prometheus queries. Bumped 4s → 10s after staging
 *  logs showed `quantile_over_time(0.99, …[24h])` consistently taking
 *  4-8s under load (observed 2026-05-26), which would otherwise abort
 *  the query and collapse the bench to a draft render. 10s is the safe
 *  upper bound for our heaviest percentile-over-window queries while
 *  still bounding the SSR render at a tolerable ceiling. */
const DEFAULT_TIMEOUT_MS = 10_000;

export class Prometheus {
  constructor(public readonly baseUrl: string) {
    if (!baseUrl) throw new Error("Prometheus baseUrl is required");
    // Belt-and-suspenders: even the operator-set env URL is sanity-checked,
    // so a typo (http://, embedded basic-auth, javascript:) fails fast at
    // construction time rather than leaking creds on every fetch.
    let u: URL;
    try {
      u = new URL(baseUrl);
    } catch {
      throw new Error("Prometheus baseUrl is not a valid URL");
    }
    if (u.protocol !== "https:") {
      throw new Error("Prometheus baseUrl must be https://");
    }
    if (u.username || u.password) {
      throw new Error("Prometheus baseUrl must not embed credentials");
    }
  }

  /** GET /api/v1/query. instant query at evaluation time `now`. */
  async query(promql: string, signal?: AbortSignal): Promise<PromInstantResult> {
    const url = new URL("/api/v1/query", this.baseUrl);
    url.searchParams.set("query", promql);
    return this.fetchEnvelope<PromInstantResult>(url, signal);
  }

  /** GET /api/v1/query_range. range query for series/sparklines. */
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

  /** Age in seconds of the most recent sample for the metric used in the
   *  given query. Derived by extracting the first raw metric identifier
   *  from the query and asking Prom for `time() - max(timestamp(<metric>))`.
   *
   *  Returns null when the metric name cannot be extracted (unusual query
   *  shape) or when Prom has no samples for it. Callers should fall back
   *  to a sensible default in that case.
   *
   *  This is a single instant query, shared cache-friendly. one extra
   *  round-trip per benchmark per ISR cycle. */
  async dataAgeSec(promql: string): Promise<number | null> {
    const metric = extractMetricName(promql);
    if (!metric) return null;
    return this.scalar(`scalar(time() - max(timestamp(${metric})))`);
  }

  /** Convenience: scalar number from any instant query, or null if empty
   *  / error. Errors are logged with the query that failed and the
   *  underlying reason ("empty", "timeout", network error, parse error)
   *  so a misbehaving spec or a flaky Prom doesn't disappear into a
   *  silent null. Callers stay simple - they keep the existing
   *  `null = no data` semantics - but operators can grep vercel logs
   *  for `prom.scalar` to find the actual failure mode.
   *
   *  The query string is truncated to 200 chars to avoid leaking a
   *  multi-line PromQL into the log line. */
  async scalar(promql: string): Promise<number | null> {
    try {
      const res = await this.query(promql);
      if (res.resultType === "scalar") {
        const v = Number(res.result[1]);
        return Number.isFinite(v) ? v : null;
      }
      if (res.resultType === "vector" && res.result.length > 0) {
        const v = Number(res.result[0].value[1]);
        return Number.isFinite(v) ? v : null;
      }
      return null; // legitimately empty - not an error, not logged
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : String(err);
      console.warn(
        `prom.scalar failed (${reason}) for query: ${promql.slice(0, 200)}`,
      );
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
    // Defense in depth against DNS-rebinding: the schema guards URL
    // literals, but a hostname can resolve to a private address at fetch
    // time. Refuse if any resolved IP is loopback / RFC1918 / link-local
    // / metadata / ULA / CGNAT.
    await assertPublicHost(url);

    // Global concurrency cap. At cold start / build every bench loads at
    // once, which used to fire hundreds of 24h-window quantile queries
    // within seconds and brown out the single Prom instance (providers
    // timing out → partial leaderboards). Queueing here keeps the burst
    // at a level Prom absorbs; total wall time barely moves because Prom
    // was serializing on CPU anyway.
    await acquireQuerySlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const merged = signal ? mergeSignals(signal, controller.signal) : controller.signal;
      const res = await fetch(url, {
        signal: merged,
        // Refuse to follow redirects. blocks 3xx into a private host.
        redirect: "manual",
        // Cache at the platform level. pages call us through ISR.
        next: { revalidate: 60 },
      });
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`prometheus: refused redirect (${res.status})`);
      }
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
      releaseQuerySlot();
    }
  }
}

/** Module-level semaphore for fetchEnvelope. 8 concurrent queries keeps
 *  a Railway-sized Prom responsive while ~30 benches load in parallel. */
const MAX_CONCURRENT_QUERIES = 8;
let activeQueries = 0;
const queryWaiters: (() => void)[] = [];

function acquireQuerySlot(): Promise<void> {
  if (activeQueries < MAX_CONCURRENT_QUERIES) {
    activeQueries++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queryWaiters.push(resolve));
}

function releaseQuerySlot(): void {
  const next = queryWaiters.shift();
  // Hand the slot directly to the next waiter (activeQueries unchanged)
  // or free it when the queue is empty.
  if (next) next();
  else activeQueries--;
}

/** PromQL built-in functions and keywords we should skip when scanning
 *  for the first raw metric name in a query string. Updated from the
 *  Prometheus 2.49 function reference - any identifier here is guaranteed
 *  not to be a real metric, so `dataAgeSec` won't probe a non-existent
 *  series and silently fall back to `now`. */
const PROMQL_RESERVED = new Set([
  // Aggregation operators
  "sum", "avg", "max", "min", "count", "count_values", "stddev", "stdvar",
  "topk", "bottomk", "group", "quantile",
  // Aggregation modifiers / keywords
  "on", "ignoring", "group_left", "group_right", "by", "without", "bool",
  "and", "or", "unless", "offset",
  // Range vector / time functions
  "rate", "irate", "increase", "delta", "idelta", "deriv", "predict_linear",
  "quantile_over_time", "avg_over_time", "max_over_time", "min_over_time",
  "sum_over_time", "count_over_time", "stddev_over_time", "stdvar_over_time",
  "last_over_time", "present_over_time", "mad_over_time",
  "changes", "resets",
  // Histogram helpers
  "histogram_quantile", "histogram_sum", "histogram_count", "histogram_avg",
  "histogram_fraction", "histogram_stddev", "histogram_stdvar",
  // Label manipulation
  "label_replace", "label_join",
  // Math / unary
  "abs", "floor", "ceil", "round", "exp", "ln", "log2", "log10", "sqrt",
  "clamp_max", "clamp_min", "clamp", "sgn", "sort", "sort_desc",
  // Trig
  "atan", "atanh", "acos", "acosh", "asin", "asinh",
  "cos", "cosh", "sin", "sinh", "tan", "tanh", "deg", "rad",
  // Time
  "time", "timestamp", "scalar", "vector", "minute", "hour",
  "day_of_month", "day_of_week", "day_of_year", "days_in_month",
  "month", "year",
  // Set helpers
  "absent", "absent_over_time", "present", "pi",
]);

/** Best-effort extraction of the first raw metric identifier from a PromQL
 *  query. Returns null when nothing recognisable is found. Used by
 *  `dataAgeSec` to build a freshness probe without needing the spec to
 *  declare it explicitly.
 *
 *  Strategy: prefer identifiers immediately followed by `{` (label selector)
 *  or `[` (range vector) - those are always real metric references, never
 *  functions. Falls back to the reserved-set scan for queries like
 *  `metric_name` or `metric > 0` that don't carry a selector. */
export function extractMetricName(promql: string): string | null {
  const withSelector = /\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b\s*[{[]/g;
  const m = withSelector.exec(promql);
  if (m) {
    const name = m[1];
    if (!PROMQL_RESERVED.has(name) && !/^\d/.test(name)) return name;
  }
  const re = /\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b/g;
  let next: RegExpExecArray | null;
  while ((next = re.exec(promql)) !== null) {
    const name = next[1];
    if (PROMQL_RESERVED.has(name)) continue;
    if (/^\d/.test(name)) continue;
    return name;
  }
  return null;
}

/** Reject loopback, private, link-local, metadata, ULA, CGNAT, and the
 *  IPv6 re-encodings that wrap a private v4. Mirrors the schema-time check
 *  but operates on resolved IPs so a hostname that publicly resolved at PR
 *  time can't get repointed to 169.254.169.254 at fetch time. */
function isPrivateAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 0) return false;
  if (family === 4) {
    if (addr === "0.0.0.0") return true;
    if (/^127\./.test(addr)) return true;
    if (/^10\./.test(addr)) return true;
    if (/^192\.168\./.test(addr)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true;
    if (/^169\.254\./.test(addr)) return true;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)) return true; // CGNAT
    return false;
  }
  // IPv6
  const a = addr.toLowerCase();
  if (a === "::1" || a === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true; // ULA
  if (/^fe80:/.test(a)) return true; // link-local
  // IPv4-mapped IPv6 - recurse on the embedded v4 address.
  const mapped = /^::ffff:([0-9.]+)$/.exec(a);
  if (mapped) return isPrivateAddress(mapped[1]);
  // NAT64 (RFC 6052) - last 32 bits encode a v4 address.
  if (/^64:ff9b:/.test(a)) return true;
  // 6to4 (RFC 3056) - second/third hextets encode the v4 address.
  // Conservative: reject any 6to4 whose embedded v4 lands in a private range.
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(a);
  if (sixToFour) {
    const b1 = parseInt(sixToFour[1], 16);
    const b2 = parseInt(sixToFour[2], 16);
    const v4 = `${(b1 >> 8) & 0xff}.${b1 & 0xff}.${(b2 >> 8) & 0xff}.${b2 & 0xff}`;
    if (isPrivateAddress(v4)) return true;
  }
  return false;
}

/** dns.lookup hangs on getaddrinfo with no built-in timeout. A malicious
 *  spec URL pointing at an unresolvable hostname would stall the route
 *  for 20-30 s, easily DoSing /api/freshness. Race the lookup against a
 *  short timer. */
const DNS_TIMEOUT_MS = 1500;

async function dnsLookupWithTimeout(host: string): Promise<{ address: string }[]> {
  return Promise.race([
    dns.lookup(host, { all: true }) as Promise<{ address: string; family: number }[]>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`dns: timeout resolving ${host}`)), DNS_TIMEOUT_MS),
    ),
  ]);
}

// Cache the host-validation result for 60 s so the DNS lookup isn't
// repeated on every Prom query. The validation result ("this hostname
// resolves only to public addresses") doesn't change minute-to-minute
// in honest operation; capping the cache at 60 s also bounds the
// DNS-rebinding window for a hostile-DNS attacker to a single minute
// per spec - they'd still need to flip DNS through the cache miss to
// reach a private IP.
type HostCheckEntry = { ok: boolean; reason?: string; expiresAt: number };
const HOST_CHECK_TTL_MS = 60_000;
const hostCheckCache = new Map<string, HostCheckEntry>();

async function assertPublicHost(url: URL): Promise<void> {
  // hostname keeps brackets for IPv6 literals; strip them so isIP can
  // recognise the address.
  let host = url.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  const cached = hostCheckCache.get(host);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    if (!cached.ok) throw new Error(`prometheus: ${cached.reason}`);
    return;
  }

  try {
    if (isIP(host)) {
      if (isPrivateAddress(host)) {
        const reason = `refused private host ${host}`;
        hostCheckCache.set(host, { ok: false, reason, expiresAt: now + HOST_CHECK_TTL_MS });
        throw new Error(`prometheus: ${reason}`);
      }
      hostCheckCache.set(host, { ok: true, expiresAt: now + HOST_CHECK_TTL_MS });
      return;
    }
    const addrs = await dnsLookupWithTimeout(host);
    for (const { address } of addrs) {
      if (isPrivateAddress(address)) {
        const reason = `${host} resolves to private address ${address}`;
        hostCheckCache.set(host, { ok: false, reason, expiresAt: now + HOST_CHECK_TTL_MS });
        throw new Error(`prometheus: ${reason}`);
      }
    }
    hostCheckCache.set(host, { ok: true, expiresAt: now + HOST_CHECK_TTL_MS });
  } catch (e) {
    // DNS timeout / NXDOMAIN: do NOT cache as failure forever - let the
    // next request retry. Only the explicit "private address" path above
    // gets cached on failure.
    throw e;
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
