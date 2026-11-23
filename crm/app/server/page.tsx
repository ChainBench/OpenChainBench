import { Shell } from "@/components/shell";
import { Empty, Kpi, Lines } from "@/components/ui";
import { loadServerStats, SERIES_HOURS, type DiskRow, type ServerStats } from "@/lib/server";
import { readSnapshot } from "@/lib/snapshot";
import { parseWindow } from "@/lib/window";

export const dynamic = "force-dynamic";

const gb = (b: number) => (Number.isFinite(b) ? `${(b / 1e9).toFixed(b >= 100e9 ? 0 : 1)} GB` : "–");
const pct = (x: number, digits = 0) => (Number.isFinite(x) ? `${x.toFixed(digits)}%` : "–");
const num = (x: number, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : "–");

/** A missing hour draws as the hour before it rather than as a drop to zero. */
const fill = (xs: number[]) => {
  let last = xs.find(Number.isFinite) ?? 0;
  return xs.map((v) => (Number.isFinite(v) ? (last = v) : last));
};
const finite = (xs: number[]) => xs.filter(Number.isFinite);
const peak = (xs: number[]) => (finite(xs).length ? Math.max(...finite(xs)) : NaN);

// Same bands as the rest of the CRM: warn before it hurts, bad when it does.
const tone = (x: number, warn: number, bad: number) => (x >= bad ? "var(--bad)" : x >= warn ? "var(--warn)" : undefined);

function trend(d: DiskRow) {
  const f = d.freePerDay7d;
  if (f == null || !Number.isFinite(f)) return "–";
  if (Math.abs(f) < 0.05e9) return "flat";
  return `${f < 0 ? "+" : "−"}${gb(Math.abs(f))}/day`;
}

export default async function ServerPage({ searchParams }: { searchParams: Promise<{ refresh?: string; w?: string }> }) {
  const [snap, sp] = await Promise.all([readSnapshot(), searchParams]);
  const w = parseWindow(sp.w);
  let s: ServerStats | null = null;
  let error: string | null = null;
  try {
    s = await loadServerStats();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const memUsedPct = s ? 100 * (1 - s.memAvailable / s.memTotal) : NaN;
  const days = SERIES_HOURS / 24;

  return (
    <Shell current="/server" snapshot={snap} refreshFlag={sp.refresh} window={w}>
      {error ? (
        <p className="panel mb-4 px-4 py-3 text-xs" style={{ color: "var(--warn)" }}>
          Could not read the VPS from Prometheus: {error}
        </p>
      ) : null}

      {s ? (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi
              label="CPU now (5 min)"
              value={pct(s.cpuPct5m)}
              sub={`${s.cores} cores · 24 h avg ${pct(s.cpuPct24h)} · peak ${pct(s.cpuPeak24h)}`}
            />
            <Kpi label="Load (1 / 5 / 15 min)" value={num(s.load[0])} sub={`${num(s.load[1])} · ${num(s.load[2])} · ${num(s.load[0] / s.cores)} per core`} />
            <Kpi label="Memory used" value={pct(memUsedPct)} sub={`${gb(s.memTotal - s.memAvailable)} of ${gb(s.memTotal)} · no swap`} />
            {(() => {
              const d = s.disks.find((x) => x.mount === "/data") ?? s.disks[0];
              return d ? (
                <Kpi
                  label={`Disk ${d.mount}`}
                  value={pct(d.usedPct)}
                  sub={`${gb(d.avail)} free · ${d.daysToFull != null ? `full in ~${Math.round(d.daysToFull)} d at the 7 d rate` : "not filling"}`}
                />
              ) : (
                <Kpi label="Disk" value="–" />
              );
            })()}
          </section>

          <section className="panel mt-6 p-4">
            <p className="label">CPU and memory, last {days} days (hourly average, %)</p>
            <Lines
              series={[
                { name: "CPU", color: "var(--accent)", values: fill(s.series.cpuPct) },
                { name: "Memory", color: "var(--good)", values: fill(s.series.memPct) },
              ]}
              legend={(v) => `peak ${pct(peak(v))}`}
            />
          </section>

          <section className="panel mt-6 p-4">
            <p className="label">Load average (1 min), last {days} days, hourly average · {s.cores} cores</p>
            <Lines series={[{ name: "Load", color: "var(--warn)", values: fill(s.series.load1) }]} legend={(v) => `peak ${num(peak(v))}`} height={90} />
          </section>

          <section className="panel mt-6 p-4">
            <p className="label">Disks</p>
            {s.disks.length ? (
              <table className="data mt-2">
                <thead>
                  <tr>
                    <th>Mount</th>
                    <th>Device</th>
                    <th className="num">Size</th>
                    <th className="num">Free</th>
                    <th className="num">Used</th>
                    <th className="num">Growth, 7 d</th>
                    <th className="num">Full in</th>
                  </tr>
                </thead>
                <tbody>
                  {s.disks.map((d) => (
                    <tr key={d.mount}>
                      <td className="mono">{d.mount}</td>
                      <td className="mono" style={{ color: "var(--muted)" }}>
                        {d.device}
                      </td>
                      <td className="num mono">{gb(d.size)}</td>
                      <td className="num mono">{gb(d.avail)}</td>
                      <td className="num mono" style={{ color: tone(d.usedPct, 75, 90) }}>
                        {pct(d.usedPct)}
                      </td>
                      <td className="num mono">{trend(d)}</td>
                      <td className="num mono" style={{ color: d.daysToFull != null ? d.daysToFull < 14 ? "var(--bad)" : d.daysToFull < 30 ? "var(--warn)" : undefined : undefined }}>
                        {d.daysToFull == null ? "–" : d.daysToFull > 365 ? "over a year" : `~${Math.round(d.daysToFull)} d`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty text="No filesystem series." />
            )}
            {s.tsdb ? (
              <p className="mt-3 text-xs">
                Prometheus store: <span className="mono">{gb(s.tsdb.bytes)}</span>
                {s.tsdb.perDay7d != null ? (
                  <>
                    , <span className="mono">+{gb(s.tsdb.perDay7d)}/day</span> over 7 d
                  </>
                ) : null}
                {s.tsdb.oldest ? `; oldest sample ${s.tsdb.oldest.slice(0, 10)}` : ""}
                {s.tsdb.retention ? `, retention ${s.tsdb.retention}; it keeps growing until its oldest sample is ${s.tsdb.retention} old` : ""}.
              </p>
            ) : null}
            <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
              The OCB VPS ({s.cores} cores, {gb(s.memTotal)}, no swap), read live from node-exporter through Prometheus at {s.asOf.slice(11, 16)} UTC; up {Math.floor(s.uptimeDays)} days. Docker,
              Prometheus and Postgres live on /data. Growth is the linear trend of free space over 7 days; &quot;full in&quot; extrapolates it. A shorter window would mislead: /data fills by several GB during the day and part of it is freed between about 03:00 and 06:00 UTC, so a 24 h slope swings from about −10 to +10 GB/day. Network is
              left out: node-exporter runs on the compose network and only sees its own traffic. There is no per-container breakdown yet: cAdvisor on this host exports
              only the root cgroup.
            </p>
          </section>
        </>
      ) : null}
    </Shell>
  );
}
