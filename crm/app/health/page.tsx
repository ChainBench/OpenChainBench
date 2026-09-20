import { Shell, fmtAge } from "@/components/shell";
import { Empty, fmtInt, Kpi } from "@/components/ui";
import { readHistory, readSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
const SITE = `https://${process.env.SITE_HOST ?? "openchainbench.com"}`;

export default async function HealthPage({ searchParams }: { searchParams: Promise<{ refresh?: string }> }) {
  const [snap, history, sp] = await Promise.all([readSnapshot(), readHistory(), searchParams]);
  const b = snap.benches;
  const h = snap.harness;
  const d = snap.dune;
  const builtAge = b?.builtAt ? (Date.now() - Date.parse(b.builtAt)) / 60_000 : null;
  const duneDaysLeft = d?.periodEnd ? Math.max(0, Math.ceil((Date.parse(d.periodEnd) - Date.now()) / 86_400_000)) : null;

  return (
    <Shell current="/health" snapshot={snap} refreshFlag={sp.refresh}>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Live benches" value={b ? fmtInt(b.total) : "–"} sub={b ? `${fmtInt(b.fresh)} fresh` : undefined} />
        <Kpi label="Stale (> 24 h)" value={b ? fmtInt(b.stale) : "–"} sub="the page says so" />
        <Kpi label="Expired (> 7 d)" value={b ? fmtInt(b.expired) : "–"} sub="noindex, out of the sitemap" />
        <Kpi label="Blob published" value={builtAge != null ? fmtAge(builtAge) : "–"} sub={b?.builtAt ?? undefined} />
      </section>
      <section className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Harness targets" value={h ? `${h.up}/${h.total} up` : "–"} />
        <Kpi label="Targets down" value={h ? fmtInt(h.down.length) : "–"} />
        <Kpi
          label="Dune credits"
          value={d ? `${fmtInt(d.creditsUsed)}/${fmtInt(d.creditsIncluded)}` : "–"}
          sub={d ? `period ends ${d.periodEnd ?? "?"}${duneDaysLeft != null ? ` (${duneDaysLeft} d)` : ""}` : "DUNE_API_KEY not set"}
        />
        <Kpi label="Providers in the index" value={b ? fmtInt(b.providers) : "–"} />
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <div className="panel p-4">
          <p className="label">Benches by category</p>
          {b ? (
            <table className="data mt-2">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num">Live</th>
                  <th className="num">Stale</th>
                  <th className="num">Expired</th>
                </tr>
              </thead>
              <tbody>
                {b.byCategory.map((c) => (
                  <tr key={c.category}>
                    <td>{c.category}</td>
                    <td className="num mono">{fmtInt(c.total)}</td>
                    <td className="num mono" style={c.stale > 0 ? { color: "var(--warn)" } : undefined}>
                      {fmtInt(c.stale)}
                    </td>
                    <td className="num mono" style={c.expired > 0 ? { color: "var(--bad)" } : undefined}>
                      {fmtInt(c.expired)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="Sitemap blob not loaded yet." />
          )}
        </div>
        <div className="panel p-4">
          <p className="label">Targets down</p>
          {h && h.down.length > 0 ? (
            <table className="data mt-2">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Instance</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {h.down.map((t) => (
                  <tr key={`${t.job}/${t.instance}`}>
                    <td className="mono">{t.job}</td>
                    <td className="mono" style={{ color: "var(--muted)" }}>
                      {t.instance}
                    </td>
                    <td className="text-xs" style={{ color: "var(--bad)" }}>
                      {t.lastError.slice(0, 120)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : h ? (
            <Empty text="Every scrape target is up." />
          ) : (
            <Empty text="Prometheus targets not loaded yet." />
          )}
        </div>
      </section>

      <section className="panel mt-6 p-4">
        <p className="label">Benches needing attention (oldest first)</p>
        {b && b.attention.length > 0 ? (
          <table className="data mt-2">
            <thead>
              <tr>
                <th>Bench</th>
                <th>Category</th>
                <th>State</th>
                <th className="num">Age</th>
                <th>Last run</th>
              </tr>
            </thead>
            <tbody>
              {b.attention.map((r) => (
                <tr key={r.slug}>
                  <td className="mono">
                    <a href={`${SITE}/benchmarks/${r.slug}`} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                      {r.slug}
                    </a>
                  </td>
                  <td style={{ color: "var(--muted)" }}>{r.category}</td>
                  <td style={{ color: r.state === "stale" ? "var(--warn)" : "var(--bad)" }}>{r.state}</td>
                  <td className="num mono">{r.ageHours != null ? `${r.ageHours.toFixed(r.ageHours < 100 ? 1 : 0)} h` : "–"}</td>
                  <td className="mono" style={{ color: "var(--muted)" }}>
                    {r.lastRunAt ?? "never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : b ? (
          <Empty text="Every live bench measured in the last 24 h." />
        ) : (
          <Empty text="Sitemap blob not loaded yet." />
        )}
      </section>

      <section className="panel mt-6 p-4">
        <p className="label">Daily history (one line per refresh day, kept on the volume)</p>
        {history.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="data mt-2">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="num">Visitors 7 d</th>
                  <th className="num">Pageviews 7 d</th>
                  <th className="num">AI, current week</th>
                  <th className="num">Search, current week</th>
                  <th className="num">Benches</th>
                  <th className="num">Stale + expired</th>
                  <th className="num">Targets down</th>
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().slice(0, 60).map((l) => (
                  <tr key={l.day}>
                    <td className="mono">{l.day}</td>
                    <td className="num mono">{fmtInt(l.visitors7d)}</td>
                    <td className="num mono">{fmtInt(l.pageviews7d)}</td>
                    <td className="num mono">{fmtInt(l.aiVisitors7d)}</td>
                    <td className="num mono">{fmtInt(l.searchVisitors7d)}</td>
                    <td className="num mono">{fmtInt(l.benches)}</td>
                    <td className="num mono">{fmtInt(l.stale)}</td>
                    <td className="num mono">{fmtInt(l.targetsDown)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text="First refresh writes the first line." />
        )}
      </section>
    </Shell>
  );
}
