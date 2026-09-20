import { Shell } from "@/components/shell";
import { Bars, Delta, Empty, fmtInt, fmtPct, Kpi, Spark } from "@/components/ui";
import { SECTION_LABEL, type Section } from "@/lib/channels";
import { readSnapshot } from "@/lib/snapshot";
import { drainConfigured, drainStats, readDays, type DayAggregate } from "@/lib/vercel-logs";

export const dynamic = "force-dynamic";
const SITE = `https://${process.env.SITE_HOST ?? "openchainbench.com"}`;

const sumMap = (days: DayAggregate[], pick: (d: DayAggregate) => Record<string, number>) => {
  const out: Record<string, number> = {};
  for (const d of days) for (const [k, v] of Object.entries(pick(d))) out[k] = (out[k] ?? 0) + v;
  return out;
};
const sorted = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]);
const total = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

export default async function CrawlersPage({ searchParams }: { searchParams: Promise<{ refresh?: string }> }) {
  const [snap, sp, days] = await Promise.all([readSnapshot(), searchParams, readDays(28)]);
  const today = new Date().toISOString().slice(0, 10);
  const last7 = days.filter((d) => d.day > new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  const prev7 = days.filter((d) => d.day <= new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10) && d.day > new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10));
  const ai = sumMap(last7, (d) => d.aiBots);
  const aiPrev = sumMap(prev7, (d) => d.aiBots);
  const search = sumMap(last7, (d) => d.searchBots);
  const searchPrev = sumMap(prev7, (d) => d.searchBots);
  const cls = sumMap(last7, (d) => d.byClass);
  const status = sumMap(last7, (d) => d.status);
  const nf = sumMap(last7, (d) => d.notFound);
  const cache = sumMap(last7, (d) => d.cache);
  const aiSections = sumMap(last7, (d) => d.aiBySection);
  const humanSections = sumMap(last7, (d) => d.humanBySection);
  const api: Record<string, Record<string, number>> = {};
  for (const d of last7) for (const [fam, m] of Object.entries(d.api)) api[fam] = { ...(api[fam] ?? {}), ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, (api[fam]?.[k] ?? 0) + v])) };
  const series = (pick: (d: DayAggregate) => number) => {
    const by = new Map(days.map((d) => [d.day, pick(d)]));
    return Array.from({ length: 28 }, (_, i) => by.get(new Date(Date.now() - (27 - i) * 86_400_000).toISOString().slice(0, 10)) ?? 0);
  };
  const cacheHits = (cache.HIT ?? 0) + (cache.STALE ?? 0) + (cache.PRERENDER ?? 0);
  const cacheTotal = total(cache);
  const nf404Posthog = snap.traffic.notFound ?? [];
  const stats = drainStats();

  return (
    <Shell current="/crawlers" snapshot={snap} refreshFlag={sp.refresh}>
      {!drainConfigured() || days.length === 0 ? (
        <section className="panel mb-4 p-5">
          <p className="label">Vercel request logs</p>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            {drainConfigured()
              ? `Receiver armed, no request folded yet (${stats.received} entries received since start). Vercel needs the drain enabled: Team settings → Log Drains → Add, sources "Request logs", format JSON, endpoint https://<this host>/api/ingest/vercel, with the custom secret set as VERCEL_LOG_DRAIN_SECRET.`
              : "Not connected. Set VERCEL_LOG_DRAIN_SECRET (16+ chars) and VERCEL_LOG_DRAIN_VERIFY on the Railway service, then add a Log Drain in the Vercel team settings (Request logs, JSON) pointing at /api/ingest/vercel on this host. AI crawlers, search bots, 404s and API hits appear here, per day, kept on the volume."}
          </p>
        </section>
      ) : null}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="AI crawler hits, 7 d" value={fmtInt(total(ai))} delta={{ now: total(ai), prev: total(aiPrev) }} sub={`${Object.keys(ai).length} bots`} />
        <Kpi label="Search bot hits, 7 d" value={fmtInt(total(search))} delta={{ now: total(search), prev: total(searchPrev) }} />
        <Kpi label="Human requests, 7 d" value={fmtInt(cls.human)} sub={`${fmtInt(cls.other_bot)} other bots`} />
        <Kpi label="404s, 7 d" value={fmtInt(status["404"])} sub={cacheTotal > 0 ? `cache hit ${fmtPct(cacheHits / cacheTotal)}` : undefined} />
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <div className="panel p-4">
          <p className="label">AI crawler hits per day, 28 d</p>
          {days.length > 1 ? <Spark series={series((d) => total(d.aiBots))} color="var(--good)" /> : <Empty text="No log data yet." />}
          <p className="label mt-4">By bot, 7 d</p>
          {sorted(ai).length > 0 ? (
            <table className="data mt-2">
              <tbody>
                {sorted(ai).map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono">{k}</td>
                    <td className="num mono">{fmtInt(v)}</td>
                    <td className="num mono">
                      <Delta now={v} prev={aiPrev[k] ?? 0} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="No AI crawler seen in the window." />
          )}
        </div>
        <div className="panel p-4">
          <p className="label">What AI crawlers read, 7 d (sections)</p>
          {sorted(aiSections).length > 0 ? (
            <Bars rows={sorted(aiSections).map(([k, v]) => ({ label: SECTION_LABEL[k as Section] ?? k, value: v }))} />
          ) : (
            <Empty text="No data yet." />
          )}
          <p className="label mt-4">What humans read, 7 d (sections, server side)</p>
          {sorted(humanSections).length > 0 ? (
            <Bars rows={sorted(humanSections).slice(0, 8).map(([k, v]) => ({ label: SECTION_LABEL[k as Section] ?? k, value: v }))} />
          ) : (
            <Empty text="No data yet." />
          )}
        </div>
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <div className="panel p-4">
          <p className="label">Machine surfaces, 7 d (who calls the API and llms.txt)</p>
          {Object.keys(api).length > 0 ? (
            <table className="data mt-2">
              <thead>
                <tr>
                  <th>Path</th>
                  <th className="num">Human</th>
                  <th className="num">AI bots</th>
                  <th className="num">Search bots</th>
                  <th className="num">Other bots</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(api)
                  .sort((a, b) => total(b[1]) - total(a[1]))
                  .map(([fam, m]) => (
                    <tr key={fam}>
                      <td className="mono">{fam}</td>
                      <td className="num mono">{fmtInt(m.human)}</td>
                      <td className="num mono">{fmtInt(m.ai_bot)}</td>
                      <td className="num mono">{fmtInt(m.search_bot)}</td>
                      <td className="num mono">{fmtInt(m.other_bot)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <Empty text="No data yet." />
          )}
          <p className="label mt-4">Search bots, 7 d</p>
          {sorted(search).length > 0 ? (
            <Bars rows={sorted(search).map(([k, v]) => ({ label: k, value: v }))} />
          ) : (
            <Empty text="No data yet." />
          )}
        </div>
        <div className="panel p-4">
          <p className="label">Top 404 paths, 7 d (server logs)</p>
          {sorted(nf).length > 0 ? (
            <table className="data mt-2">
              <tbody>
                {sorted(nf)
                  .slice(0, 25)
                  .map(([k, v]) => (
                    <tr key={k}>
                      <td className="mono truncate" style={{ maxWidth: 380 }} title={k}>
                        {k}
                      </td>
                      <td className="num mono">{fmtInt(v)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <Empty text="No 404 recorded." />
          )}
          <p className="label mt-4">404s seen by visitors, 7 d (browser event, with the referrer)</p>
          {nf404Posthog.length > 0 ? (
            <table className="data mt-2">
              <tbody>
                {nf404Posthog.slice(0, 15).map((r) => (
                  <tr key={r.path}>
                    <td className="mono truncate" style={{ maxWidth: 300 }} title={r.path}>
                      {r.path}
                    </td>
                    <td className="mono" style={{ color: "var(--muted)" }}>
                      {r.topReferrer || "direct"}
                    </td>
                    <td className="num mono">{fmtInt(r.hits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="No visitor hit a 404 in the window." />
          )}
        </div>
      </section>
      <p className="mt-3 text-[11px]" style={{ color: "var(--faint)" }}>
        Today is {today}; the last day of the series is partial. Assets, /_next and /ingest are excluded; hosts other than {SITE.replace("https://", "")} are ignored.
      </p>
    </Shell>
  );
}
