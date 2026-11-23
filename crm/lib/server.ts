/**
 * The OCB VPS, read from node-exporter through the same Prometheus the
 * harness section uses. Read at render rather than from the snapshot: the
 * queries are cheap and the point of the page is how the box is doing now.
 *
 * What node-exporter can and cannot say here:
 *  - CPU, load, memory and filesystems are the host's (it runs with the host
 *    PID namespace and the root filesystem mounted at /host).
 *  - Network is NOT: the container sits on the compose network, so its eth0
 *    counters are its own scrape traffic (a few hundred bytes a second). The
 *    page leaves network out rather than show that.
 *  - Per-container usage would come from cAdvisor, which on this host only
 *    exports the root cgroup (`id="/"`), so there is no breakdown yet.
 */
import { z } from "zod";

const PROM_URL = (process.env.PROM_URL ?? "https://prom.openchainbench.com").replace(/\/$/, "");
const JOB = 'job="node-exporter"';
// Mounts worth showing; /boot and /boot/efi are fixed-size and never move.
const MOUNTS = ["/", "/data"];

export const SERIES_HOURS = 7 * 24;
const SERIES_STEP_SEC = 3600;

const vectorSchema = z.object({
  data: z.object({ result: z.array(z.object({ metric: z.record(z.string(), z.string()), value: z.tuple([z.number(), z.string()]) })) }),
});
const matrixSchema = z.object({
  data: z.object({ result: z.array(z.object({ metric: z.record(z.string(), z.string()), values: z.array(z.tuple([z.number(), z.string()])) })) }),
});

export type DiskRow = {
  mount: string;
  device: string;
  size: number;
  avail: number;
  usedPct: number;
  /** Bytes per day the free space moved over the last 7 days (negative = filling). */
  freePerDay7d: number | null;
  /** Days until the free space reaches zero at the 7 day rate; null when not filling. */
  daysToFull: number | null;
};

export type ServerStats = {
  asOf: string;
  cores: number;
  memTotal: number;
  memAvailable: number;
  cpuPct5m: number;
  cpuPct24h: number;
  cpuPeak24h: number;
  load: [number, number, number];
  uptimeDays: number;
  disks: DiskRow[];
  /** Prometheus's own store on /data: the one thing on the box that grows by design. */
  tsdb: { bytes: number; perDay7d: number | null; oldest: string | null; retention: string | null } | null;
  /** Hourly points over the last SERIES_HOURS, oldest first. */
  series: { t: number[]; cpuPct: number[]; memPct: number[]; load1: number[] };
};

async function promGet(path: string, params: Record<string, string>): Promise<unknown> {
  const url = `${PROM_URL}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
  // Prometheus says what is wrong with a query in the body of its 400.
  if (!res.ok) throw new Error(`prometheus ${path} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

async function vector(query: string) {
  return vectorSchema.parse(await promGet("/api/v1/query", { query })).data.result;
}

/** One number, or null when the series is absent (exporter down). */
async function scalar(query: string): Promise<number | null> {
  const r = await vector(query);
  const v = r[0] ? Number(r[0].value[1]) : NaN;
  return Number.isFinite(v) ? v : null;
}

/** Values of a single-series range query, aligned on `t` (missing steps are NaN). */
export function alignRange(result: { values: [number, string][] }[], t: number[]): number[] {
  const byT = new Map((result[0]?.values ?? []).map(([ts, v]) => [ts, Number(v)]));
  return t.map((ts) => byT.get(ts) ?? NaN);
}

/**
 * Days until full at a given free-space rate. Only a falling free space has a
 * date; a flat or growing one returns null rather than a huge number.
 */
export function daysToFull(avail: number, freePerDay: number | null): number | null {
  if (freePerDay == null || !(freePerDay < 0)) return null;
  return avail / -freePerDay;
}

const cpuExpr = (w: string) => `100 * (1 - avg(rate(node_cpu_seconds_total{${JOB},mode="idle"}[${w}])))`;
const memExpr = `100 * (1 - node_memory_MemAvailable_bytes{${JOB}} / node_memory_MemTotal_bytes{${JOB}})`;

export async function loadServerStats(now = Date.now()): Promise<ServerStats> {
  // A slash needs no escaping in a PromQL regex, and `\/` is not a valid escape there.
  const fsSel = `${JOB},mountpoint=~"${MOUNTS.join("|")}"`;
  const end = Math.floor(now / 1000 / SERIES_STEP_SEC) * SERIES_STEP_SEC;
  const start = end - SERIES_HOURS * 3600;
  const range = (query: string) =>
    promGet("/api/v1/query_range", { query, start: String(start), end: String(end), step: String(SERIES_STEP_SEC) }).then(
      (j) => matrixSchema.parse(j).data.result,
    );

  const [cores, memTotal, memAvailable, cpu5m, cpu24h, cpuPeak, l1, l5, l15, uptime, size, avail, d7, cpuR, memR, loadR, tsdbBytes, tsdbGrowth, tsdbOldest, retention] = await Promise.all([
    scalar(`count(node_cpu_seconds_total{${JOB},mode="idle"})`),
    scalar(`node_memory_MemTotal_bytes{${JOB}}`),
    scalar(`node_memory_MemAvailable_bytes{${JOB}}`),
    scalar(cpuExpr("5m")),
    scalar(cpuExpr("24h")),
    scalar(`max_over_time((${cpuExpr("5m")})[24h:5m])`),
    scalar(`node_load1{${JOB}}`),
    scalar(`node_load5{${JOB}}`),
    scalar(`node_load15{${JOB}}`),
    scalar(`node_time_seconds{${JOB}} - node_boot_time_seconds{${JOB}}`),
    vector(`node_filesystem_size_bytes{${fsSel}}`),
    vector(`node_filesystem_avail_bytes{${fsSel}}`),
    vector(`deriv(node_filesystem_avail_bytes{${fsSel}}[7d]) * 86400`),
    range(`${cpuExpr("1h")}`),
    range(`avg_over_time((${memExpr})[1h:5m])`),
    range(`avg_over_time(node_load1{${JOB}}[1h])`),
    scalar(`prometheus_tsdb_storage_blocks_bytes{job="prometheus"} + prometheus_tsdb_wal_storage_size_bytes{job="prometheus"}`),
    // Blocks compact in steps, so a week's difference, not a deriv.
    scalar(`(prometheus_tsdb_storage_blocks_bytes{job="prometheus"} - prometheus_tsdb_storage_blocks_bytes{job="prometheus"} offset 7d) / 7`),
    scalar(`prometheus_tsdb_lowest_timestamp_seconds{job="prometheus"}`),
    promGet("/api/v1/status/runtimeinfo", {})
      .then((j) => z.object({ data: z.object({ storageRetention: z.string() }) }).parse(j).data.storageRetention)
      .catch(() => null),
  ]);
  if (cores == null || memTotal == null) throw new Error("node-exporter series missing (exporter down?)");

  const byMount = (rows: { metric: Record<string, string>; value: [number, string] }[]) =>
    new Map(rows.map((r) => [r.metric.mountpoint ?? "", Number(r.value[1])]));
  const availM = byMount(avail);
  const d7M = byMount(d7);
  const disks: DiskRow[] = size
    .map((r) => {
      const mount = r.metric.mountpoint ?? "";
      const sz = Number(r.value[1]);
      const av = availM.get(mount) ?? NaN;
      const f7 = d7M.has(mount) ? d7M.get(mount)! : null;
      return {
        mount,
        device: r.metric.device ?? "",
        size: sz,
        avail: av,
        usedPct: sz > 0 ? (100 * (sz - av)) / sz : NaN,
        freePerDay7d: f7,
        daysToFull: daysToFull(av, f7),
      };
    })
    .sort((a, b) => MOUNTS.indexOf(a.mount) - MOUNTS.indexOf(b.mount));

  const t: number[] = [];
  for (let ts = start; ts <= end; ts += SERIES_STEP_SEC) t.push(ts);

  return {
    asOf: new Date(now).toISOString(),
    cores,
    memTotal,
    memAvailable: memAvailable ?? NaN,
    cpuPct5m: cpu5m ?? NaN,
    cpuPct24h: cpu24h ?? NaN,
    cpuPeak24h: cpuPeak ?? NaN,
    load: [l1 ?? NaN, l5 ?? NaN, l15 ?? NaN],
    uptimeDays: uptime == null ? NaN : uptime / 86400,
    disks,
    tsdb:
      tsdbBytes == null
        ? null
        : { bytes: tsdbBytes, perDay7d: tsdbGrowth, oldest: tsdbOldest == null ? null : new Date(tsdbOldest * 1000).toISOString(), retention },
    series: { t, cpuPct: alignRange(cpuR, t), memPct: alignRange(memR, t), load1: alignRange(loadR, t) },
  };
}
