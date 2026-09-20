import { Shell } from "@/components/shell";
import { Bars, Delta, Empty, fmtInt, fmtPct, Kpi } from "@/components/ui";
import { readSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

const CHANNEL_LABEL = { ai: "AI", search: "Search", social: "Social", direct: "Direct", referral: "Referral", internal: "Internal" } as const;

export default async function AudiencePage({ searchParams }: { searchParams: Promise<{ refresh?: string }> }) {
  const [snap, sp] = await Promise.all([readSnapshot(), searchParams]);
  const t = snap.traffic;
  const a = t.audience;
  const total = a ? a.newVisitors + a.returningVisitors : 0;
  const referrers = (t.referrers ?? []).filter((r) => r.channel !== "direct" && r.channel !== "internal" && (r.visitors > 0 || r.prevVisitors > 0)).slice(0, 40);

  return (
    <Shell current="/audience" snapshot={snap} refreshFlag={sp.refresh}>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="New visitors, 7 d" value={fmtInt(a?.newVisitors)} sub={a && total > 0 ? `${fmtPct(a.newVisitors / total)} of active` : undefined} />
        <Kpi label="Returning visitors, 7 d" value={fmtInt(a?.returningVisitors)} sub={a && total > 0 ? `${fmtPct(a.returningVisitors / total)} of active` : "first seen before the window"} />
        <Kpi label="Sessions, 7 d" value={fmtInt(t.engagement?.sessions)} />
        <Kpi label="Bounce rate" value={fmtPct(t.engagement?.bounceRate)} sub="single-pageview sessions" />
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <div className="panel p-4">
          <p className="label">Countries, 7 d</p>
          {t.countries && t.countries.length > 0 ? (
            <Bars rows={t.countries.slice(0, 15).map((c) => ({ label: c.name, value: c.visitors, hint: `· ${fmtPct(c.share)}` }))} />
          ) : (
            <Empty text="No geo data yet." />
          )}
        </div>
        <div className="panel p-4">
          <p className="label">Devices, 7 d</p>
          {t.devices && t.devices.length > 0 ? (
            <Bars rows={t.devices.map((d) => ({ label: d.name, value: d.visitors, hint: `· ${fmtPct(d.share)}` }))} />
          ) : (
            <Empty text="No device data yet." />
          )}
          <p className="label mt-6">UTM sources, 7 d</p>
          {t.utm && t.utm.length > 0 ? (
            <table className="data mt-2">
              <tbody>
                {t.utm.map((u) => (
                  <tr key={`${u.source}/${u.medium}`}>
                    <td className="mono">{u.source}</td>
                    <td style={{ color: "var(--muted)" }}>{u.medium}</td>
                    <td className="num mono">{fmtInt(u.visitors)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="No tagged campaign traffic in the window." />
          )}
        </div>
      </section>

      <section className="panel mt-6 p-4">
        <p className="label">Referring domains, 7 d (direct and internal excluded)</p>
        {referrers.length > 0 ? (
          <table className="data mt-2">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Channel</th>
                <th className="num">Visitors</th>
                <th className="num">w/w</th>
                <th className="num">Pageviews</th>
              </tr>
            </thead>
            <tbody>
              {referrers.map((r) => (
                <tr key={r.domain}>
                  <td className="mono">{r.domain}</td>
                  <td style={{ color: r.channel === "ai" ? "var(--good)" : "var(--muted)" }}>{CHANNEL_LABEL[r.channel]}</td>
                  <td className="num mono">{fmtInt(r.visitors)}</td>
                  <td className="num mono">
                    <Delta now={r.visitors} prev={r.prevVisitors} />
                  </td>
                  <td className="num mono">{fmtInt(r.pageviews)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty text="No referrer data yet." />
        )}
      </section>
    </Shell>
  );
}
