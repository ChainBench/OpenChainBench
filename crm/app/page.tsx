import Link from "next/link";
import { Shell } from "@/components/shell";
import { Metric } from "@/components/metric";
import { Bars, Delta, Empty, fmtInt, fmtPct, Kpi, Spark } from "@/components/ui";
import { SECTION_LABEL } from "@/lib/channels";
import { readSnapshot } from "@/lib/snapshot";
import { channelTotals, sectionTotals } from "@/lib/traffic";

export const dynamic = "force-dynamic";

const CHANNEL_LABEL = { ai: "AI assistants", search: "Search", social: "Social", direct: "Direct", referral: "Other sites", internal: "Internal" } as const;

export default async function Overview({ searchParams }: { searchParams: Promise<{ refresh?: string }> }) {
  const [snap, sp] = await Promise.all([readSnapshot(), searchParams]);
  const t = snap.traffic;
  const totals = t.totals;
  const weekly = t.weekly ?? [];
  // Set below, after the partial-history helpers: the last two weeks that
  // are both complete and fully covered by the data.
  const channels = channelTotals(t.referrers ?? []);
  // Exact 7 d uniques for the two headline channels; the channel table
  // below sums per-domain uniques and can count a visitor twice.
  const ai = totals ? { visitors: totals.aiVisitors, prevVisitors: totals.prevAiVisitors } : undefined;
  const search = totals ? { visitors: totals.searchVisitors, prevVisitors: totals.prevSearchVisitors } : undefined;
  // PostHog started receiving events on 2026-09-20 (the site token shipped
  // as the literal "[SENSITIVE]" from 2026-08-24 until then), so the 28-day
  // and 12-week windows are mostly empty and the cards must say so instead
  // of implying a month of history.
  const firstDay = t.daily?.[0]?.day ?? null;
  const windowStart = new Date(Date.now() - 27 * 864e5).toISOString().slice(0, 10);
  const partialHistory = Boolean(firstDay && firstDay > windowStart);
  const dailyLabel = partialHistory
    ? `Daily visitors, since ${firstDay} (${t.daily?.length ?? 0} d)`
    : "Daily visitors, 28 d";
  // A week that began before the first event holds a few days at most.
  const weekIsPartial = (week: string) => Boolean(firstDay && week < firstDay);
  // The rows are keyed by the Monday that opens the week (HogQL
  // toStartOfWeek mode 1); print the span so a Monday date is never read
  // as the day the numbers belong to.
  const weekRange = (monday: string) => {
    const end = new Date(`${monday}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 6);
    return `${monday} to ${end.toISOString().slice(0, 10)}`;
  };
  const fullWeeks = weekly.slice(0, -1).filter((w) => !weekIsPartial(w.week));
  const lastFull = fullWeeks.at(-1) ?? null;
  const prevFull = fullWeeks.at(-2) ?? null;
  const sections = sectionTotals(t.pages ?? []);
  // One series per headline card, from the same daily rows the chart
  // below uses, so a card and the chart can never disagree.
  const days = t.daily ?? [];
  const series = (pick: (d: (typeof days)[number]) => number) =>
    days.map((d) => ({ day: d.day, value: pick(d) }));
  const aiDomains = (t.referrers ?? []).filter((r) => r.channel === "ai" && (r.visitors > 0 || r.prevVisitors > 0)).slice(0, 12);
  const b = snap.benches;
  const h = snap.harness;

  return (
    <Shell current="/" snapshot={snap} refreshFlag={sp.refresh}>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric
          label="Visitors, 7 d"
          value={fmtInt(totals?.visitors)}
          delta={totals && { now: totals.visitors, prev: totals.prevVisitors }}
          series={series((d) => d.visitors)}
          unit="visitors"
        />
        <Metric
          label="Pageviews, 7 d"
          value={fmtInt(totals?.pageviews)}
          delta={totals && { now: totals.pageviews, prev: totals.prevPageviews }}
          series={series((d) => d.pageviews)}
          unit="pageviews"
        />
        <Metric
          label="AI-referred visitors, 7 d"
          value={fmtInt(ai?.visitors)}
          delta={ai && { now: ai.visitors, prev: ai.prevVisitors }}
          sub={ai && totals?.visitors ? `${fmtPct(ai.visitors / totals.visitors, 1)} of visitors` : undefined}
          series={series((d) => d.ai)}
          unit="visitors"
        />
        <Metric
          label="Search-referred visitors, 7 d"
          value={fmtInt(search?.visitors)}
          delta={search && { now: search.visitors, prev: search.prevVisitors }}
          sub={search && totals?.visitors ? `${fmtPct(search.visitors / totals.visitors, 1)} of visitors` : undefined}
          series={series((d) => d.search)}
          unit="visitors"
        />
      </section>

      <section className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric
          label="Sessions, 7 d"
          value={fmtInt(totals?.sessions)}
          delta={totals && { now: totals.sessions, prev: totals.prevSessions }}
          series={series((d) => d.sessions)}
          unit="sessions"
        />
        <Kpi label="Pages per session" value={t.engagement ? t.engagement.pagesPerSession.toFixed(2) : "–"} sub={t.engagement ? `bounce ${fmtPct(t.engagement.bounceRate)}` : undefined} />
        <Kpi
          label="Live benches"
          value={b ? fmtInt(b.total) : "–"}
          sub={b ? `${b.stale} stale · ${b.expired} expired · ${b.providers} providers` : undefined}
        />
        <Kpi label="Harness targets up" value={h ? `${h.up}/${h.total}` : "–"} sub={h && h.down.length > 0 ? `${h.down.map((d) => d.job).slice(0, 3).join(", ")}${h.down.length > 3 ? "…" : ""} down` : "all up"} />
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <div className="panel p-4">
          <p className="label">{dailyLabel}</p>
          {t.daily && t.daily.length > 1 ? (
            <>
              <Spark series={t.daily.map((d) => d.visitors)} />
              <p className="mono mt-1 flex justify-between text-[11px]" style={{ color: "var(--faint)" }}>
                <span>{t.daily[0].day}</span>
                <span>peak {fmtInt(Math.max(...t.daily.map((d) => d.visitors)))}</span>
                <span>{t.daily[t.daily.length - 1].day}</span>
              </p>
            </>
          ) : (
            <Empty text="No PostHog data yet." />
          )}
        </div>
        <div className="panel p-4">
          <p className="label">Weekly visitors from AI assistants, full weeks</p>
          {fullWeeks.length > 1 ? (
            <>
              <Spark series={fullWeeks.map((w) => w.ai)} color="var(--good)" />
              <p className="mono mt-1 text-[11px]" style={{ color: "var(--faint)" }}>
                last full week {lastFull ? `${fmtInt(lastFull.ai)} AI · ${fmtInt(lastFull.search)} search · ${fmtInt(lastFull.visitors)} total` : "–"}
                {lastFull && prevFull ? (
                  <>
                    {" "}
                    · AI <Delta now={lastFull.ai} prev={prevFull.ai} /> w/w
                  </>
                ) : null}
              </p>
            </>
          ) : (
            <Empty
              text={
                firstDay
                  ? `Two full weeks needed; PostHog data starts ${firstDay}.`
                  : "No PostHog data yet."
              }
            />
          )}
        </div>
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-3">
        <div className="panel p-4 md:col-span-1">
          <p className="label">Channels, 7 d (per-domain visitors summed)</p>
          {channels.length > 0 ? (
            <table className="data mt-2">
              <tbody>
                {channels.map((c) => (
                  <tr key={c.channel}>
                    <td>{CHANNEL_LABEL[c.channel]}</td>
                    <td className="num mono">{fmtInt(c.visitors)}</td>
                    <td className="num mono">
                      <Delta now={c.visitors} prev={c.prevVisitors} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="No referrer data yet." />
          )}
        </div>
        <div className="panel p-4">
          <p className="label">AI assistants by domain, 7 d</p>
          {aiDomains.length > 0 ? (
            <table className="data mt-2">
              <tbody>
                {aiDomains.map((r) => (
                  <tr key={r.domain}>
                    <td className="mono">{r.domain}</td>
                    <td className="num mono">{fmtInt(r.visitors)}</td>
                    <td className="num mono">
                      <Delta now={r.visitors} prev={r.prevVisitors} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="No AI-referred visit in the window." />
          )}
        </div>
        <div className="panel p-4">
          <p className="label">Sections, 7 d (page visits)</p>
          {sections.length > 0 ? (
            <Bars rows={sections.slice(0, 10).map((s) => ({ label: SECTION_LABEL[s.section], value: s.visitors, hint: `· ${s.pages} pages` }))} />
          ) : (
            <Empty text="No page data yet." />
          )}
          <p className="mt-3 text-[11px]" style={{ color: "var(--faint)" }}>
            Page visits sum per-page visitors; a visitor who saw two pages of a section counts twice. <Link href="/pages" className="underline">Pages</Link> has the per-page table.
          </p>
        </div>
      </section>

      <section className="panel mt-6 p-4">
        <p className="label">Weekly series</p>
        {weekly.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="data mt-2">
              <thead>
                <tr>
                  <th>Week (Mon to Sun)</th>
                  <th className="num">Visitors</th>
                  <th className="num">Pageviews</th>
                  <th className="num">From AI</th>
                  <th className="num">AI share</th>
                  <th className="num">From search</th>
                </tr>
              </thead>
              <tbody>
                {[...weekly].reverse().map((w, i) => (
                  <tr key={w.week} style={i === 0 ? { color: "var(--muted)" } : undefined}>
                    <td className="mono">
                      {weekRange(w.week)}
                      {i === 0 ? " (current, partial)" : weekIsPartial(w.week) ? ` (partial, data from ${firstDay})` : ""}
                    </td>
                    <td className="num mono">{fmtInt(w.visitors)}</td>
                    <td className="num mono">{fmtInt(w.pageviews)}</td>
                    <td className="num mono">{fmtInt(w.ai)}</td>
                    <td className="num mono">{fmtPct(w.visitors > 0 ? w.ai / w.visitors : 0, 1)}</td>
                    <td className="num mono">{fmtInt(w.search)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text="No PostHog data yet." />
        )}
      </section>
    </Shell>
  );
}
