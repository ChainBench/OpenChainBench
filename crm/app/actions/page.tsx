import { Shell } from "@/components/shell";
import { Delta, Empty, fmtInt, Kpi } from "@/components/ui";
import { readSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
const SITE = `https://${process.env.SITE_HOST ?? "openchainbench.com"}`;

const ACTION_LABEL: Record<string, string> = {
  outbound_click: "Outbound clicks",
  copy: "Copies",
  search: "Searches",
};

export default async function ActionsPage({ searchParams }: { searchParams: Promise<{ refresh?: string }> }) {
  const [snap, sp] = await Promise.all([readSnapshot(), searchParams]);
  const t = snap.traffic;
  const actions = t.actions ?? [];
  const byName = (n: string) => actions.find((a) => a.name === n);
  const outbound = (t.outbound ?? []).filter((o) => o.clicks > 0 || o.prevClicks > 0);
  const copies = t.copies ?? [];
  const searches = t.searches ?? [];

  return (
    <Shell current="/actions" snapshot={snap} refreshFlag={sp.refresh}>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {(["outbound_click", "copy", "search"] as const).map((n) => {
          const a = byName(n);
          return (
            <Kpi
              key={n}
              label={`${ACTION_LABEL[n]}, 7 d`}
              value={fmtInt(a?.count)}
              delta={a && { now: a.count, prev: a.prevCount }}
              sub={a ? `${fmtInt(a.visitors)} visitors` : "no event yet"}
            />
          );
        })}
      </section>
      <p className="mt-3 text-xs" style={{ color: "var(--faint)" }}>
        Events the site sends on top of pageviews (src/lib/analytics.ts). Nothing here before the site deploy that added them; the
        Actions numbers are what the traffic turns into.
      </p>

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <div className="panel p-4">
          <p className="label">Where visitors go, 7 d (outbound clicks by host)</p>
          {outbound.length > 0 ? (
            <table className="data mt-2">
              <thead>
                <tr>
                  <th>Host</th>
                  <th className="num">Clicks</th>
                  <th className="num">w/w</th>
                  <th className="num">Visitors</th>
                  <th>From</th>
                </tr>
              </thead>
              <tbody>
                {outbound.map((o) => (
                  <tr key={o.host}>
                    <td className="mono">{o.host}</td>
                    <td className="num mono">{fmtInt(o.clicks)}</td>
                    <td className="num mono">
                      <Delta now={o.clicks} prev={o.prevClicks} />
                    </td>
                    <td className="num mono">{fmtInt(o.visitors)}</td>
                    <td className="mono truncate" style={{ maxWidth: 200, color: "var(--muted)" }} title={o.topPage}>
                      {o.topPage}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="No outbound click recorded yet." />
          )}
        </div>
        <div className="panel p-4">
          <p className="label">What gets copied, 7 d</p>
          {copies.length > 0 ? (
            <table className="data mt-2">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Value</th>
                  <th>Bench</th>
                  <th className="num">Copies</th>
                </tr>
              </thead>
              <tbody>
                {copies.map((c, i) => (
                  <tr key={`${c.kind}/${c.value}/${c.bench}/${i}`}>
                    <td>{c.kind}</td>
                    <td className="mono truncate" style={{ maxWidth: 260 }} title={c.value}>
                      {c.value || "–"}
                    </td>
                    <td className="mono" style={{ color: "var(--muted)" }}>
                      {c.bench ? (
                        <a href={`${SITE}/benchmarks/${c.bench}`} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                          {c.bench}
                        </a>
                      ) : (
                        "–"
                      )}
                    </td>
                    <td className="num mono">{fmtInt(c.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="No copy recorded yet." />
          )}
        </div>
      </section>

      <section className="panel mt-6 p-4">
        <p className="label">What people search for, 7 d (a result was picked)</p>
        {searches.length > 0 ? (
          <table className="data mt-2">
            <thead>
              <tr>
                <th>Query</th>
                <th className="num">Times</th>
                <th>Kind</th>
                <th>Landed on</th>
              </tr>
            </thead>
            <tbody>
              {searches.map((s) => (
                <tr key={s.query}>
                  <td className="mono">{s.query}</td>
                  <td className="num mono">{fmtInt(s.count)}</td>
                  <td style={{ color: "var(--muted)" }}>{s.kind || "–"}</td>
                  <td className="mono" style={{ color: "var(--muted)" }}>
                    {s.url}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty text="No search recorded yet." />
        )}
      </section>
    </Shell>
  );
}
