import { FrequencyPanel, RetentionGrid } from "@/components/retention";
import { Shell } from "@/components/shell";
import { Bars, Delta, Empty, fmtInt, fmtPct, Kpi, Lines } from "@/components/ui";
import { SECTION_LABEL } from "@/lib/channels";
import { readSnapshot } from "@/lib/snapshot";

const fmtMs = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const fmtSec = (v: number) => (v >= 60 ? `${Math.floor(v / 60)} min ${Math.round(v % 60)} s` : `${Math.round(v)} s`);
const vitalTone = (v: number, good: number, poor: number) => (v <= good ? "var(--good)" : v <= poor ? "var(--warn)" : "var(--bad)");

export const dynamic = "force-dynamic";

const CHANNEL_LABEL = { ai: "AI", search: "Search", social: "Social", direct: "Direct", referral: "Referral", internal: "Internal" } as const;

const SURFACE_SERIES = [
  { key: "pageviews", name: "HTML pageviews", color: "var(--accent)" },
  { key: "markdown", name: "Markdown reads (Accept: text/markdown)", color: "var(--good)" },
  { key: "stat", name: "/api/stat reads (edge-cache fills)", color: "var(--warn)" },
  { key: "citable", name: "/api/citable reads (edge-cache fills)", color: "var(--bad)" },
] as const;

const EVENT_LABEL: Record<string, string> = { markdown_read: "Markdown", stat_read: "/api/stat", citable_read: "/api/citable" };

type Kpi = "visitors" | "new" | "returning" | "sessions" | "bounce" | "pageviews";
type Grain = "day" | "week" | "month";

const KPI_META: Record<Kpi, { label: string; definition: string; additive: boolean; pct?: boolean }> = {
  visitors: { label: "Active visitors", definition: "Distinct device cookies with at least one pageview in the bucket. Uniques do not add up across days: a week or a month is the sum of its days' uniques, an upper bound.", additive: false },
  new: { label: "New visitors", definition: "Visitors whose first pageview ever (on this PostHog history, since 2026-09-20) falls in the bucket. Additive.", additive: true },
  returning: { label: "Returning visitors", definition: "GA4 definition: visitors active in the bucket who had a pageview on an earlier day. A visitor first seen on Monday and back on Thursday counts as new for the week and as returning on Thursday. Per bucket, not additive across days.", additive: false },
  sessions: { label: "Sessions", definition: "Distinct PostHog session ids with a pageview in the bucket. Additive.", additive: true },
  pageviews: { label: "Pageviews", definition: "HTML pageviews from the browser SDK. Additive.", additive: true },
  bounce: { label: "Bounce rate", definition: "Share of the bucket's sessions with a single pageview (sessions dated by their first pageview).", additive: false, pct: true },
};

function bucketOf(day: string, grain: Grain): string {
  if (grain === "day") return day;
  if (grain === "month") return day.slice(0, 7);
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Series for one KPI at one grain, from the daily sections. */
function kpiSeries(t: { audienceDaily?: { day: string; visitors: number; newVisitors: number; returningVisitors: number; sessions: number; pageviews: number }[]; bounceDaily?: { day: string; sessions: number; bounced: number }[] }, kpi: Kpi, grain: Grain): { bucket: string; value: number }[] {
  const acc = new Map<string, { num: number; den: number }>();
  if (kpi === "bounce") {
    for (const d of t.bounceDaily ?? []) {
      const b = bucketOf(d.day, grain);
      const cur = acc.get(b) ?? { num: 0, den: 0 };
      cur.num += d.bounced;
      cur.den += d.sessions;
      acc.set(b, cur);
    }
    return [...acc.entries()].map(([bucket, v]) => ({ bucket, value: v.den > 0 ? v.num / v.den : 0 }));
  }
  for (const d of t.audienceDaily ?? []) {
    const b = bucketOf(d.day, grain);
    const cur = acc.get(b) ?? { num: 0, den: 0 };
    cur.num += kpi === "visitors" ? d.visitors : kpi === "new" ? d.newVisitors : kpi === "returning" ? d.returningVisitors : kpi === "sessions" ? d.sessions : d.pageviews;
    acc.set(b, cur);
  }
  return [...acc.entries()].map(([bucket, v]) => ({ bucket, value: v.num }));
}

export default async function AudiencePage({ searchParams }: { searchParams: Promise<{ refresh?: string; range?: string; kpi?: string; g?: string }> }) {
  const [snap, sp] = await Promise.all([readSnapshot(), searchParams]);
  const t = snap.traffic;
  const a = t.audience;
  const active = a?.activeVisitors ?? 0;
  const firstDay = t.daily?.[0]?.day ?? null;
  const kpi: Kpi | null = (["visitors", "new", "returning", "sessions", "bounce", "pageviews"] as const).find((k) => k === sp.kpi) ?? null;
  const grain: Grain = sp.g === "week" || sp.g === "month" ? sp.g : "day";
  const detail = kpi ? kpiSeries(t, kpi, grain) : [];
  const detailShown = grain === "day" ? detail.slice(-28) : detail;
  const fmtVal = (v: number) => (kpi === "bounce" ? fmtPct(v) : fmtInt(v));
  const kpiHref = (k: Kpi) => `/audience?kpi=${k}&g=${grain}${sp.range ? `&range=${sp.range}` : ""}`;
  const grainHref = (g: Grain) => `/audience?kpi=${kpi}&g=${g}${sp.range ? `&range=${sp.range}` : ""}`;
  const range = sp.range === "all" ? "all" : "28";
  const surfacesAll = t.surfaces ?? [];
  const surfaces = range === "all" ? surfacesAll : surfacesAll.slice(-28);
  const maxPv = Math.max(0, ...surfaces.map((d) => d.pageviews));
  const maxReads = Math.max(0, ...surfaces.map((d) => Math.max(d.markdown, d.stat, d.citable)));
  const logScale = maxReads > 0 && maxPv > 20 * maxReads;
  const families = (() => {
    const by = new Map<string, number>();
    for (const f of t.families ?? []) by.set(f.family, (by.get(f.family) ?? 0) + f.reads);
    return [...by.entries()].map(([label, value]) => ({ label, value })).sort((x, y) => y.value - x.value).slice(0, 15);
  })();
  const referrers = (t.referrers ?? []).filter((r) => r.channel !== "direct" && r.channel !== "internal" && (r.visitors > 0 || r.prevVisitors > 0)).slice(0, 40);

  return (
    <Shell current="/audience" snapshot={snap} refreshFlag={sp.refresh}>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {(
          [
            ["visitors", "Active visitors, 7 d", fmtInt(active), "click for the daily series"],
            ["new", "New visitors, 7 d", fmtInt(a?.newVisitors), active > 0 && a ? `${fmtPct(a.newVisitors / active)} of active, first pageview in the window` : undefined],
            ["returning", "Returning visitors, 7 d", fmtInt(a?.returningVisitors), active > 0 && a ? `${fmtPct(a.returningVisitors / active)} of active, seen on an earlier day` : "seen on an earlier day"],
            ["sessions", "Sessions, 7 d", fmtInt(t.engagement?.sessions), undefined],
            ["bounce", "Bounce rate, 7 d", fmtPct(t.engagement?.bounceRate), "single-pageview sessions"],
          ] as const
        ).map(([k, label, value, sub]) => (
          <a key={k} href={kpi === k ? `/audience${sp.range ? `?range=${sp.range}` : ""}` : kpiHref(k)} className="block" style={kpi === k ? { outline: "1px solid var(--accent)", borderRadius: 8 } : undefined}>
            <Kpi label={label} value={value} sub={sub} />
          </a>
        ))}
      </section>

      {kpi && (
        <section className="mt-3 panel p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="label">
              {KPI_META[kpi].label}, {grain === "day" ? `daily, last ${detailShown.length} d` : grain === "week" ? `weekly (Monday to Sunday), ${detailShown.length} w` : `monthly, ${detailShown.length} m`}
              {firstDay ? `, history since ${firstDay}` : ""}
            </p>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {(["day", "week", "month"] as const).map((g, i) => (
                <span key={g}>
                  {i > 0 ? " · " : ""}
                  <a href={grainHref(g)} style={{ color: grain === g ? "var(--ink)" : undefined }}>{g === "day" ? "daily" : g === "week" ? "weekly" : "monthly"}</a>
                </span>
              ))}
              {" · "}
              <a href={kpi === "pageviews" ? kpiHref("visitors") : kpiHref("pageviews")}>{kpi === "pageviews" ? "visitors" : "pageviews"}</a>
            </p>
          </div>
          {detailShown.length > 1 ? (
            <>
              <div className="mt-2">
                <Lines series={[{ name: KPI_META[kpi].label, color: "var(--accent)", values: detailShown.map((d) => (kpi === "bounce" ? Math.round(d.value * 1000) / 10 : d.value)) }]} />
              </div>
              <div className="mt-1 flex justify-between text-[11px]" style={{ color: "var(--faint)" }}>
                <span>{detailShown[0].bucket}</span>
                <span>peak {fmtVal(Math.max(...detailShown.map((d) => d.value)))}</span>
                <span>{detailShown[detailShown.length - 1].bucket}</span>
              </div>
              <table className="data mt-3">
                <tbody>
                  {[...detailShown].reverse().slice(0, grain === "day" ? 14 : 12).map((d) => (
                    <tr key={d.bucket}>
                      <td className="mono">{d.bucket}</td>
                      <td className="num mono">{fmtVal(d.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <Empty text={detailShown.length === 1 ? `One bucket so far: ${detailShown[0].bucket}, ${fmtVal(detailShown[0].value)}.` : "No daily series yet; the next refresh fills it."} />
          )}
          <p className="mt-3 text-[11px]" style={{ color: "var(--faint)" }}>{KPI_META[kpi].definition}{kpi === "visitors" && grain !== "day" ? " Weekly uniques from PostHog are on the Overview page." : ""}</p>
        </section>
      )}

      <section className="mt-6 panel p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="label">
            Reads per surface, daily{firstDay ? `, since ${firstDay}` : ""} ({surfaces.length} d{logScale ? ", log scale" : ""})
          </p>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            <a href="/audience?range=28" style={{ color: range === "28" ? "var(--ink)" : undefined }}>28 d</a>
            {" · "}
            <a href="/audience?range=all" style={{ color: range === "all" ? "var(--ink)" : undefined }}>all ({surfacesAll.length} d, up to 90)</a>
          </p>
        </div>
        {surfaces.length > 1 ? (
          <>
            <div className="mt-2">
              <Lines
                logScale={logScale}
                series={SURFACE_SERIES.map((s) => ({ name: s.name, color: s.color, values: surfaces.map((d) => d[s.key]) }))}
              />
            </div>
            <div className="mt-1 flex justify-between text-[11px]" style={{ color: "var(--faint)" }}>
              <span>{surfaces[0].day}</span>
              <span>{surfaces[surfaces.length - 1].day}</span>
            </div>
          </>
        ) : (
          <Empty text="No daily series yet." />
        )}
        <p className="mt-3 text-[11px]" style={{ color: "var(--faint)" }}>
          HTML pageviews come from the browser SDK. The three server surfaces are captured on the server since 2026-09-24 (release after that date on production):
          Markdown is one event per read; /api/stat (60 s) and /api/citable (1 h) sit behind an edge cache and count cache fills, so they undercount.
          The nightly HF publisher reads /api/stat for every bench and shows up as family &quot;other&quot;.
        </p>
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-[3fr_2fr]">
        <div className="panel p-4">
          <p className="label">Endpoints read by agents, 7 d</p>
          {t.endpoints && t.endpoints.some((e) => e.reads > 0) ? (
            <table className="data mt-2">
              <thead>
                <tr>
                  <th>Surface</th>
                  <th>Path</th>
                  <th className="num">Reads</th>
                  <th className="num">vs prev 7 d</th>
                  <th className="num">Agents</th>
                  <th>Top families</th>
                </tr>
              </thead>
              <tbody>
                {t.endpoints
                  .filter((e) => e.reads > 0)
                  .slice(0, 40)
                  .map((e) => (
                    <tr key={`${e.event}:${e.path}`}>
                      <td>{EVENT_LABEL[e.event] ?? e.event}</td>
                      <td className="mono truncate" style={{ maxWidth: 320 }} title={e.path}>
                        {e.path}
                      </td>
                      <td className="num mono">{fmtInt(e.reads)}</td>
                      <td className="num">
                        <Delta now={e.reads} prev={e.prevReads} />
                      </td>
                      <td className="num mono">{fmtInt(e.agents)}</td>
                      <td className="mono" style={{ color: "var(--muted)" }}>
                        {e.families.join(", ")}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <Empty text="No server-side read yet on production (ships with the next release)." />
          )}
        </div>
        <div className="panel p-4">
          <p className="label">Agent families, 7 d (server reads)</p>
          {families.length > 0 ? <Bars rows={families} /> : <Empty text="No server-side read yet on production." />}
          <p className="mt-3 text-[11px]" style={{ color: "var(--faint)" }}>
            Family is a coarse user-agent bucket (gptbot, claudebot, perplexitybot, googlebot, curl, python, browser). Distinct agents are counted per user agent per day, never per IP.
          </p>
        </div>
      </section>

      <section className="mt-6 grid gap-3">
        <RetentionGrid rows={t.retention ?? []} firstDay={t.daily?.[0]?.day ?? null} />
      </section>

      <section className="mt-3 grid gap-3 md:grid-cols-2">
        <FrequencyPanel rows={t.frequency ?? []} />
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

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <div className="panel p-4">
          <p className="label">Core Web Vitals, 7 d (p75, by device)</p>
          {t.vitals && t.vitals.length > 0 ? (
            <table className="data mt-2">
              <thead>
                <tr>
                  <th>Device</th>
                  <th className="num">Samples</th>
                  <th className="num">LCP</th>
                  <th className="num">INP</th>
                  <th className="num">CLS</th>
                  <th className="num">FCP</th>
                </tr>
              </thead>
              <tbody>
                {t.vitals.map((v) => (
                  <tr key={v.device}>
                    <td>{v.device}</td>
                    <td className="num mono">{fmtInt(v.samples)}</td>
                    <td className="num mono" style={{ color: vitalTone(v.lcpP75, 2500, 4000) }}>{fmtMs(v.lcpP75)}</td>
                    <td className="num mono" style={{ color: vitalTone(v.inpP75, 200, 500) }}>{fmtMs(v.inpP75)}</td>
                    <td className="num mono" style={{ color: vitalTone(v.clsP75, 0.1, 0.25) }}>{v.clsP75.toFixed(3)}</td>
                    <td className="num mono" style={{ color: vitalTone(v.fcpP75, 1800, 3000) }}>{fmtMs(v.fcpP75)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="No web vitals sample yet." />
          )}
          <p className="mt-3 text-[11px]" style={{ color: "var(--faint)" }}>
            Google&apos;s thresholds: LCP 2.5 s, INP 200 ms, CLS 0.1 (good), 4 s / 500 ms / 0.25 (poor). Ranking signal on mobile.
          </p>
        </div>
        <div className="panel p-4">
          <p className="label">Time on page by section, 7 d (median of leaves)</p>
          {t.engaged && t.engaged.length > 0 ? (
            <table className="data mt-2">
              <thead>
                <tr>
                  <th>Section</th>
                  <th className="num">Leaves</th>
                  <th className="num">Median</th>
                  <th className="num">p75</th>
                </tr>
              </thead>
              <tbody>
                {t.engaged.map((e) => (
                  <tr key={e.section}>
                    <td>{SECTION_LABEL[e.section]}</td>
                    <td className="num mono">{fmtInt(e.leaves)}</td>
                    <td className="num mono">{fmtSec(e.medianSec)}</td>
                    <td className="num mono">{fmtSec(e.p75Sec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="No pageleave data yet." />
          )}
          <p className="label mt-4">Pages read longest (3+ leaves)</p>
          {t.engagedPages && t.engagedPages.length > 0 ? (
            <table className="data mt-2">
              <tbody>
                {[...t.engagedPages]
                  .sort((a, b) => b.medianSec - a.medianSec)
                  .slice(0, 10)
                  .map((p) => (
                    <tr key={p.path}>
                      <td className="mono truncate" style={{ maxWidth: 300 }} title={p.path}>
                        {p.path}
                      </td>
                      <td className="num mono">{fmtInt(p.leaves)}</td>
                      <td className="num mono">{fmtSec(p.medianSec)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <Empty text="Nothing yet." />
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
