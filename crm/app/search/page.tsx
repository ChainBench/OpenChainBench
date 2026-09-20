import { Shell } from "@/components/shell";
import { Delta, Empty, fmtInt, fmtPct, Kpi, Spark } from "@/components/ui";
import { GSC_UNSET, readSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
const SITE = `https://${process.env.SITE_HOST ?? "openchainbench.com"}`;

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ refresh?: string }> }) {
  const [snap, sp] = await Promise.all([readSnapshot(), searchParams]);
  const g = snap.gsc;
  const t = g?.totals;

  return (
    <Shell current="/search" snapshot={snap} refreshFlag={sp.refresh}>
      {!g ? (
        <section className="panel p-5">
          <p className="label">Google Search Console</p>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            Not connected. Create a Google Cloud service account, enable the Search Console API, add the account&apos;s e-mail as a user of the
            property in Search Console, then set <code className="mono">GSC_SERVICE_ACCOUNT_JSON</code> (the key file on one line) and{" "}
            <code className="mono">GSC_SITE_URL</code> on the Railway service. The refresh after that fills this page.
          </p>
          {snap.status.gsc?.error && snap.status.gsc.error !== GSC_UNSET && (
            <p className="mono mt-3 text-xs" style={{ color: "var(--bad)" }}>
              Last attempt failed: {snap.status.gsc.error}
            </p>
          )}
        </section>
      ) : (
        <>
          <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
            Search Console lags about three days. Window {g.window.start} → {g.window.end}, compared with {g.window.prevStart} → {g.window.prevEnd}. Property{" "}
            <span className="mono">{g.siteUrl}</span>.
          </p>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="Clicks, 7 d" value={fmtInt(t?.clicks)} delta={t && { now: t.clicks, prev: t.prev.clicks }} />
            <Kpi label="Impressions, 7 d" value={fmtInt(t?.impressions)} delta={t && { now: t.impressions, prev: t.prev.impressions }} />
            <Kpi label="CTR" value={fmtPct(t?.ctr, 2)} sub={t ? `previous ${fmtPct(t.prev.ctr, 2)}` : undefined} />
            <Kpi label="Average position" value={t ? t.position.toFixed(1) : "–"} sub={t ? `previous ${t.prev.position.toFixed(1)}` : undefined} />
          </section>

          <section className="mt-6 grid gap-3 md:grid-cols-2">
            <div className="panel p-4">
              <p className="label">Daily clicks, 28 d</p>
              {g.daily.length > 1 ? <Spark series={g.daily.map((d) => d.clicks)} /> : <Empty text="No data." />}
            </div>
            <div className="panel p-4">
              <p className="label">Daily impressions, 28 d</p>
              {g.daily.length > 1 ? <Spark series={g.daily.map((d) => d.impressions)} color="var(--good)" /> : <Empty text="No data." />}
            </div>
          </section>

          <section className="panel mt-6 p-4">
            <p className="label">Opportunities: 50+ impressions, CTR under 1 %, position 15 or better (title and description work)</p>
            {g.opportunities.length > 0 ? (
              <DimTable rows={g.opportunities} link />
            ) : (
              <Empty text="No page matches the filter in this window." />
            )}
          </section>

          <section className="mt-6 grid gap-3 md:grid-cols-2">
            <div className="panel p-4">
              <p className="label">Top pages, 7 d</p>
              <DimTable rows={g.pages.slice(0, 40)} link />
            </div>
            <div className="panel p-4">
              <p className="label">Top queries, 7 d</p>
              <DimTable rows={g.queries.slice(0, 40)} />
            </div>
          </section>
        </>
      )}
    </Shell>
  );
}

function DimTable({ rows, link }: { rows: { key: string; clicks: number; impressions: number; ctr: number; position: number; prevClicks: number; prevImpressions: number }[]; link?: boolean }) {
  if (rows.length === 0) return <Empty text="No rows." />;
  return (
    <div className="overflow-x-auto">
      <table className="data mt-2">
        <thead>
          <tr>
            <th>{link ? "Page" : "Query"}</th>
            <th className="num">Clicks</th>
            <th className="num">w/w</th>
            <th className="num">Impr.</th>
            <th className="num">w/w</th>
            <th className="num">CTR</th>
            <th className="num">Pos.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="mono truncate" style={{ maxWidth: 360 }} title={r.key}>
                {link ? (
                  <a href={`${SITE}${r.key}`} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                    {r.key}
                  </a>
                ) : (
                  r.key
                )}
              </td>
              <td className="num mono">{fmtInt(r.clicks)}</td>
              <td className="num mono">
                <Delta now={r.clicks} prev={r.prevClicks} />
              </td>
              <td className="num mono">{fmtInt(r.impressions)}</td>
              <td className="num mono">
                <Delta now={r.impressions} prev={r.prevImpressions} />
              </td>
              <td className="num mono">{fmtPct(r.ctr, 1)}</td>
              <td className="num mono">{r.position.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
