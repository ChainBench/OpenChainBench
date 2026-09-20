import { Shell } from "@/components/shell";
import { Delta, Empty, fmtInt } from "@/components/ui";
import { SECTION_LABEL, type Section } from "@/lib/channels";
import { readSnapshot } from "@/lib/snapshot";
import { sectionTotals } from "@/lib/traffic";

export const dynamic = "force-dynamic";
const SITE = `https://${process.env.SITE_HOST ?? "openchainbench.com"}`;

export default async function PagesPage({ searchParams }: { searchParams: Promise<{ refresh?: string; section?: string }> }) {
  const [snap, sp] = await Promise.all([readSnapshot(), searchParams]);
  const pages = snap.traffic.pages ?? [];
  const sections = sectionTotals(pages);
  const filter = (sp.section ?? "") as Section | "";
  const shown = (filter ? pages.filter((p) => p.section === filter) : pages).slice(0, 100);
  const risers = pages.filter((p) => p.prevVisitors >= 3 || p.visitors >= 3).map((p) => ({ ...p, diff: p.visitors - p.prevVisitors }));
  const up = [...risers].sort((a, b) => b.diff - a.diff).slice(0, 10);
  const down = [...risers].sort((a, b) => a.diff - b.diff).filter((p) => p.diff < 0).slice(0, 10);
  const entries = snap.traffic.entries ?? [];

  return (
    <Shell current="/pages" snapshot={snap} refreshFlag={sp.refresh}>
      <section className="panel p-4">
        <p className="label">Sections, 7 d vs previous 7 d</p>
        {sections.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="data mt-2">
              <thead>
                <tr>
                  <th>Section</th>
                  <th className="num">Page visits</th>
                  <th className="num">w/w</th>
                  <th className="num">Pageviews</th>
                  <th className="num">Pages with a visit</th>
                </tr>
              </thead>
              <tbody>
                {sections.map((s) => (
                  <tr key={s.section}>
                    <td>
                      <a href={`/pages?section=${s.section}`} className="underline-offset-2 hover:underline">
                        {SECTION_LABEL[s.section]}
                      </a>
                    </td>
                    <td className="num mono">{fmtInt(s.visitors)}</td>
                    <td className="num mono">
                      <Delta now={s.visitors} prev={s.prevVisitors} />
                    </td>
                    <td className="num mono">{fmtInt(s.pageviews)}</td>
                    <td className="num mono">{fmtInt(s.pages)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text="No PostHog data yet." />
        )}
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <div className="panel p-4">
          <p className="label">Biggest gains, 7 d vs previous 7 d</p>
          <MoverTable rows={up} />
        </div>
        <div className="panel p-4">
          <p className="label">Biggest losses</p>
          <MoverTable rows={down} />
        </div>
      </section>

      <section className="panel mt-6 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="label">Top pages, 7 d{filter ? ` · ${SECTION_LABEL[filter]}` : ""}</p>
          {filter && (
            <a href="/pages" className="text-xs underline" style={{ color: "var(--muted)" }}>
              all sections
            </a>
          )}
        </div>
        {shown.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="data mt-2">
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Section</th>
                  <th className="num">Visitors</th>
                  <th className="num">w/w</th>
                  <th className="num">Pageviews</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.path}>
                    <td className="mono">
                      <a href={`${SITE}${p.path}`} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                        {p.path}
                      </a>
                    </td>
                    <td style={{ color: "var(--muted)" }}>{SECTION_LABEL[p.section]}</td>
                    <td className="num mono">{fmtInt(p.visitors)}</td>
                    <td className="num mono">
                      <Delta now={p.visitors} prev={p.prevVisitors} />
                    </td>
                    <td className="num mono">{fmtInt(p.pageviews)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text="No page data yet." />
        )}
      </section>

      <section className="panel mt-6 p-4">
        <p className="label">Entry pages, 7 d (first page of a session)</p>
        {entries.length > 0 ? (
          <table className="data mt-2">
            <thead>
              <tr>
                <th>Path</th>
                <th>Section</th>
                <th className="num">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.path}>
                  <td className="mono">{e.path}</td>
                  <td style={{ color: "var(--muted)" }}>{SECTION_LABEL[e.section]}</td>
                  <td className="num mono">{fmtInt(e.sessions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty text="No session data yet." />
        )}
      </section>
    </Shell>
  );
}

function MoverTable({ rows }: { rows: { path: string; visitors: number; prevVisitors: number; diff: number }[] }) {
  if (rows.length === 0) return <Empty text="Nothing to show yet." />;
  return (
    <table className="data mt-2">
      <tbody>
        {rows.map((p) => (
          <tr key={p.path}>
            <td className="mono truncate" style={{ maxWidth: 320 }} title={p.path}>
              {p.path}
            </td>
            <td className="num mono" style={{ color: "var(--muted)" }}>
              {fmtInt(p.prevVisitors)} → {fmtInt(p.visitors)}
            </td>
            <td className="num mono">
              <Delta now={p.visitors} prev={p.prevVisitors} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
