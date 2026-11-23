import { Shell } from "@/components/shell";
import { Empty, Kpi, Lines } from "@/components/ui";
import { costsConfigured, dayTotal, RAILWAY_PRICES, type CostDay, type CostLine } from "@/lib/costs";
import { readSnapshot } from "@/lib/snapshot";
import { parseWindow } from "@/lib/window";

export const dynamic = "force-dynamic";

const usd = (n: number | null | undefined, digits = 2) => (n == null || !Number.isFinite(n) ? "–" : `$${n.toFixed(digits)}`);
const railwaySum = (d: CostDay) => Object.values(d.railway).reduce((s, v) => s + v, 0);
const vercelSum = (d: CostDay) => (d.vercelProject ?? 0) + (d.vercelFixed ?? 0);

const MEASUREMENT_LABEL: Record<keyof typeof RAILWAY_PRICES, string> = {
  CPU_USAGE: "CPU",
  MEMORY_USAGE_GB: "Memory",
  DISK_USAGE_GB: "Volume disk",
  NETWORK_TX_GB: "Egress",
};

function LineTable({ rows, label }: { rows: CostLine[]; label: (n: string) => string }) {
  const total = rows.reduce((s, r) => s + r.cost, 0);
  return (
    <table className="data mt-2">
      <tbody>
        {rows
          .filter((r) => r.cost >= 0.005)
          .map((r) => (
            <tr key={r.name}>
              <td>{label(r.name)}</td>
              <td className="num mono">{usd(r.cost)}</td>
              <td className="num mono" style={{ color: "var(--muted)" }}>
                {total > 0 ? `${Math.round((r.cost / total) * 100)}%` : "–"}
              </td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

export default async function CostsPage({ searchParams }: { searchParams: Promise<{ refresh?: string; w?: string }> }) {
  const [snap, sp] = await Promise.all([readSnapshot(), searchParams]);
  const w = parseWindow(sp.w);
  const c = snap.costs;
  const conf = costsConfigured();

  // A day is complete once Vercel has billed it; Railway's today is partial.
  const complete = c ? c.days.filter((d) => d.vercelProject != null) : [];
  const last = complete[complete.length - 1];
  const last7 = complete.slice(-7);
  const prev7 = complete.slice(-14, -7);
  const avg = (ds: CostDay[]) => (ds.length ? ds.reduce((s, d) => s + dayTotal(d), 0) / ds.length : 0);
  const month = last?.day.slice(0, 7);
  const monthDays = month ? complete.filter((d) => d.day.startsWith(month)) : [];
  const monthTotal = monthDays.reduce((s, d) => s + dayTotal(d), 0);
  const daysInMonth = month ? new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate() : 30;

  const chart = complete.slice(-30);

  return (
    <Shell current="/costs" snapshot={snap} refreshFlag={sp.refresh} window={w}>
      {!conf.vercel || !conf.railway ? (
        <p className="panel mb-4 px-4 py-3 text-xs" style={{ color: "var(--warn)" }}>
          {!conf.vercel ? "Vercel billing not configured (VERCEL_API_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID). " : ""}
          {!conf.railway ? "Railway usage not configured (RAILWAY_API_TOKEN)." : ""}
        </p>
      ) : null}
      {c?.sourceErrors.length ? (
        <p className="panel mb-4 px-4 py-3 text-xs" style={{ color: "var(--warn)" }}>
          Last refresh: {c.sourceErrors.join("; ")}. The days shown for that source are from the refresh before.
        </p>
      ) : null}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Last billed day" value={last ? usd(dayTotal(last)) : "–"} sub={last ? `${last.day} · Vercel ${usd(vercelSum(last))} · Railway ${usd(railwaySum(last))}` : undefined} />
        <Kpi label="Average per day, 7 d" value={last7.length ? usd(avg(last7)) : "–"} delta={prev7.length === 7 ? { now: avg(last7), prev: avg(prev7) } : undefined} />
        <Kpi
          label={month ? `${month} so far` : "Month so far"}
          value={monthDays.length ? usd(monthTotal, 0) : "–"}
          sub={monthDays.length ? `${monthDays.length} billed days · pace ${usd((monthTotal / monthDays.length) * daysInMonth, 0)} / month` : undefined}
        />
        <Kpi label="Per month at the 7 d rate" value={last7.length ? usd(avg(last7) * 30, 0) : "–"} sub="30 days" />
      </section>

      <section className="panel mt-6 p-4">
        <p className="label">Cost per day, last {chart.length} billed days (USD)</p>
        {chart.length >= 2 ? (
          <Lines
            series={[
              { name: "Total", color: "var(--accent)", values: chart.map(dayTotal) },
              { name: "Vercel", color: "var(--good)", values: chart.map(vercelSum) },
              { name: "Railway", color: "var(--warn)", values: chart.map(railwaySum) },
            ]}
          />
        ) : (
          <Empty text="Not enough billed days yet." />
        )}
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-3">
        <div className="panel p-4">
          <p className="label">Vercel, OCB project, last 7 billed days</p>
          {c && c.vercelServices7d.length ? <LineTable rows={c.vercelServices7d} label={(n) => n} /> : <Empty text="No Vercel charges loaded." />}
        </div>
        <div className="panel p-4">
          <p className="label">Vercel, team fixed charges, last 7 billed days</p>
          {c && c.vercelFixed7d.length ? <LineTable rows={c.vercelFixed7d} label={(n) => n} /> : <Empty text="No fixed charges loaded." />}
        </div>
        <div className="panel p-4">
          <p className="label">Railway, OCB projects, last 7 days</p>
          {c && c.railwayMeasurements7d.length ? (
            <LineTable rows={c.railwayMeasurements7d} label={(n) => MEASUREMENT_LABEL[n as keyof typeof RAILWAY_PRICES] ?? n} />
          ) : (
            <Empty text="No Railway usage loaded." />
          )}
        </div>
      </section>

      <section className="panel mt-6 p-4">
        <p className="label">By day</p>
        {c && c.days.length ? (
          <table className="data mt-2">
            <thead>
              <tr>
                <th>Day (UTC)</th>
                <th className="num">Vercel OCB</th>
                <th className="num">Vercel fixed</th>
                {c.railwayProjects.map((p) => (
                  <th key={p} className="num">
                    Railway {p}
                  </th>
                ))}
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {[...c.days].reverse().map((d) => (
                <tr key={d.day}>
                  <td className="mono">{d.day}</td>
                  <td className="num mono">{d.vercelProject == null ? <span style={{ color: "var(--faint)" }}>not billed yet</span> : usd(d.vercelProject)}</td>
                  <td className="num mono">{usd(d.vercelFixed)}</td>
                  {c.railwayProjects.map((p) => (
                    <td key={p} className="num mono">
                      {usd(d.railway[p])}
                    </td>
                  ))}
                  <td className="num mono">{d.vercelProject == null ? <span style={{ color: "var(--faint)" }}>partial</span> : usd(dayTotal(d))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty text="No billing data loaded yet." />
        )}
        <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
          Vercel: each day&apos;s effective cost from the team&apos;s billing export (at the start of a cycle the invoice shows 0 while the plan&apos;s included credit is used up; the cost of the day is counted anyway), OCB project lines plus the team charges with no project (Pro plan, seats,
          Flat Rate CDN); the Mobula projects on the team are left out. A Vercel day runs 08:00 to 08:00 UTC and arrives a day or two late.
          Railway: an estimate, usage times Pro list prices (vCPU-min ${RAILWAY_PRICES.CPU_USAGE}, GB-min RAM ${RAILWAY_PRICES.MEMORY_USAGE_GB}, egress $
          {RAILWAY_PRICES.NETWORK_TX_GB}/GB), per UTC day; the plan fee and any included credit are not in it.
        </p>
      </section>
    </Shell>
  );
}
