import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import { HlSparkline } from "@/components/hl-sparkline";
import { TradingAppVolumeChart, type TradingAppLine } from "@/components/trading-app-volume-chart";
import { brandColor } from "@/lib/brand";
import { lineColor } from "@/lib/series-colors";
import {
  alignedSeries,
  cohortChainSplit,
  cohortTotals,
  computeTradingAppStats,
  getTradingAppHistory,
  type TradingAppHistory,
  type TradingAppStats,
} from "@/lib/trading-app-history";

/**
 * Cross-chain daily volume block (bench 267) shared by the /trading-apps
 * hub and the "Trading app" view on /products/<slug>:
 *   1. cohort KPIs (last closed day, 7d, 30d, chains) or, on a product
 *      page, that app's own figures with rank and trend
 *   2. the daily volume chart (top apps, or the app plus the leaders)
 *   3. the table: app, chains, last day, 7d with trend, 30d, share 30d,
 *      30-day sparkline
 *   4. cohort chain split of the last closed day
 *
 * Server component reading the harness JSON (5 min revalidate). Returns
 * null when the JSON is unavailable so neither page breaks.
 */
export async function TradingAppVolumeSection({
  focus,
  compact = false,
}: {
  /** Product slug when rendered on a product page. */
  focus?: string;
  /** Product page: fewer rows in the table. */
  compact?: boolean;
}) {
  const h = await getTradingAppHistory();
  if (!h || h.apps.length === 0) return null;
  const stats = computeTradingAppStats(h);
  const totals = cohortTotals(stats);
  const me = focus ? stats.find((s) => s.app.slug === focus) : null;
  if (focus && !me) return null;

  // Chart lines: top 6 by last-day volume; on a product page the app
  // itself is always in and drawn on top.
  const topSlugs = stats.slice(0, 6).map((s) => s.app.slug);
  const lineSlugs = focus && !topSlugs.includes(focus) ? [...topSlugs.slice(0, 5), focus] : topSlugs;
  const aligned = alignedSeries(h, 365, lineSlugs);
  const lines: TradingAppLine[] = aligned.series.map((s, i) => ({
    slug: s.slug,
    name: s.name,
    color: brandColor(s.slug) ?? lineColor(i),
    values: s.values,
  }));
  const chainSplit = cohortChainSplit(h);
  const rows = compact ? stats.slice(0, 8) : stats;
  const meRank = me ? stats.findIndex((s) => s.app.slug === me.app.slug) + 1 : null;

  return (
    <div>
      {me ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
          <Kpi label="Volume, last UTC day" value={fmtUsd(me.d1)} sub={meRank ? `Rank ${meRank} of ${stats.length}` : undefined} />
          <Kpi label="Volume 7d" value={fmtUsd(me.d7)} sub={me.d7days < 7 ? `${me.d7days} of 7 days on DeFiLlama` : trendLabel(me.trend7dPct)} tone={me.d7days < 7 ? undefined : trendTone(me.trend7dPct)} />
          <Kpi label="Volume 30d" value={fmtUsd(me.d30)} sub={me.d30days < 30 ? `${me.d30days} of 30 days on DeFiLlama` : me.share30d != null ? `${me.share30d.toFixed(1)}% of cohort` : undefined} />
          <Kpi label="Chains, last day" value={String(me.chainSplit.length)} sub={me.chainSplit.slice(0, 3).map((c) => c.chain).join(", ") || undefined} />
          <Kpi label="Days of history" value={String(me.app.days.length)} sub={me.app.note ? "scope note below" : undefined} />
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <Kpi label="Cohort volume, last UTC day" value={fmtUsd(totals.d1)} sub={h.lastClosedDay} />
          <Kpi label="Cohort volume 7d" value={fmtUsd(totals.d7)} />
          <Kpi label="Cohort volume 30d" value={fmtUsd(totals.d30)} />
          <Kpi label="Leader, last day" value={stats[0]?.app.name ?? "—"} sub={fmtUsd(stats[0]?.d1 ?? null)} />
        </div>
      )}

      <div className="card-soft rounded-lg p-4 border border-ink/15 mb-8">
        <p
          className="label-mono text-[10px] uppercase tracking-wide text-ink-faint mb-3"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          Daily volume, every chain summed · closed UTC days
        </p>
        <TradingAppVolumeChart days={aligned.days} lines={lines} highlight={focus} />
      </div>

      <div className="overflow-x-auto border-y border-rule mb-6">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-rule text-left">
              <Th>App</Th>
              <Th>Chains</Th>
              <Th right>Last day</Th>
              <Th right>7d</Th>
              <Th right>7d trend</Th>
              <Th right>30d</Th>
              <Th right>Share 30d</Th>
              <Th>Last 30 days</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.map((s, i) => {
              const mine = focus === s.app.slug;
              const rank = stats.indexOf(s) + 1;
              return (
                <tr key={s.app.slug} className={mine ? "bg-paper-soft/70" : "hover:bg-paper-soft/40 transition-colors"}>
                  <td className="py-2.5 pr-3 whitespace-nowrap">
                    <span className="inline-flex items-center gap-2">
                      <span className="w-5 text-right text-ink-faint tabular-nums text-[11px]">{rank}</span>
                      {mine ? (
                        <span className="inline-flex items-center gap-2 font-semibold text-ink">
                          <ProviderLogo slug={s.app.slug} name={s.app.name} size={18} />
                          {s.app.name}
                        </span>
                      ) : (
                        <Link href={`/products/${s.app.slug}#trading-app`} className="inline-flex items-center gap-2 group">
                          <ProviderLogo slug={s.app.slug} name={s.app.name} size={18} />
                          <span className="font-medium text-ink group-hover:underline underline-offset-2">{s.app.name}</span>
                        </Link>
                      )}
                      <span className="text-[9px] uppercase tracking-[0.12em] text-ink-faint">{s.app.kind === "bot" ? "bot" : "app"}</span>
                    </span>
                  </td>
                  <td className="py-2.5 pr-3">
                    <span className="flex flex-wrap gap-1">
                      {s.chainSplit.slice(0, 4).map((c) => (
                        <span
                          key={c.chain}
                          className="rounded border border-ink/10 px-1.5 py-0.5 text-[10px] text-ink-soft whitespace-nowrap"
                          title={`${c.chain}: ${fmtUsd(c.usd)} (${c.pct.toFixed(0)}%)`}
                        >
                          {c.chain} {c.pct >= 1 ? `${c.pct.toFixed(0)}%` : "<1%"}
                        </span>
                      ))}
                      {s.chainSplit.length > 4 && (
                        <span className="text-[10px] text-ink-faint">+{s.chainSplit.length - 4}</span>
                      )}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums">{fmtUsd(s.d1)}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums">
                    {fmtUsd(s.d7)}
                    {s.d7 != null && s.d7days < 7 && <Cov days={s.d7days} of={7} />}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap" style={{ color: trendColor(s.trend7dPct) }}>
                    {trendLabel(s.trend7dPct) ?? "—"}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums">
                    {fmtUsd(s.d30)}
                    {s.d30 != null && s.d30days < 30 && <Cov days={s.d30days} of={30} />}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-ink-soft">
                    {s.share30d != null ? `${s.share30d.toFixed(1)}%` : "—"}
                  </td>
                  <td className="py-2.5 pl-3">
                    <HlSparkline values={s.last30} width={120} height={22} stroke={colorOf(s.app.slug, lines, i)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div>
          <p
            className="label-mono text-[10px] uppercase tracking-wide text-ink-faint mb-2"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            Where the cohort traded on {h.lastClosedDay}
          </p>
          <div className="flex h-3 w-full overflow-hidden rounded-sm bg-paper-soft">
            {chainSplit.map((c, i) => (
              <span key={c.chain} title={`${c.chain}: ${fmtUsd(c.usd)} (${c.pct.toFixed(1)}%)`} style={{ width: `${c.pct}%`, background: brandColor(c.chain.toLowerCase().replace(/ /g, "-")) ?? lineColor(i) }} />
            ))}
          </div>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-soft">
            {chainSplit.slice(0, 8).map((c, i) => (
              <span key={c.chain} className="inline-flex items-center gap-1.5">
                <i className="inline-block h-2 w-2 rounded-sm" style={{ background: brandColor(c.chain.toLowerCase().replace(/ /g, "-")) ?? lineColor(i) }} />
                {c.chain} {c.pct.toFixed(1)}%
              </span>
            ))}
          </p>
        </div>
        <p className="text-[11px] text-ink-faint leading-relaxed">
          Source: DeFiLlama dexs adapters (Trading App and Telegram Bot categories), per closed UTC day, every chain
          the adapter covers.{" "}
          {me?.app.note ? <span className="text-ink-soft">{me.app.note} </span> : null}
          Re-read hourly; DeFiLlama restates the last day for about 24 h. Bench{" "}
          <Link href="/benchmarks/trading-app-daily-volume" className="underline hover:no-underline">
            267
          </Link>
          , as of {new Date(h.generatedAt).toUTCString().replace("GMT", "UTC")}.
        </p>
      </div>
    </div>
  );
}

export type { TradingAppHistory, TradingAppStats };

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return (
    <div className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col" style={{ minHeight: 96 }}>
      <p
        className="text-[10px] text-ink-faint uppercase tracking-wide leading-snug"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {label}
      </p>
      <p className="mt-auto text-lg sm:text-xl font-semibold tabular-nums leading-tight">{value}</p>
      {sub && (
        <p className="mt-1 text-[10px] uppercase tracking-[0.14em] truncate" style={{ color: tone === "up" ? "var(--color-good)" : tone === "down" ? "var(--color-bad, #e5484d)" : "var(--color-ink-faint)" }} title={sub}>
          {sub}
        </p>
      )}
    </div>
  );
}

/** Chart colour when the app is on the chart, brand colour, else palette. */
function colorOf(slug: string, lines: TradingAppLine[], i: number): string {
  return lines.find((l) => l.slug === slug)?.color ?? brandColor(slug) ?? lineColor(i);
}

/** "24/30 d" marker for a window with missing days upstream. */
function Cov({ days, of }: { days: number; of: number }) {
  return (
    <span className="ml-1 text-[9px] text-ink-faint" title={`${days} of the last ${of} UTC days have a point on DeFiLlama; the sum covers those days only`}>
      {days}/{of}d
    </span>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`py-2 ${right ? "px-3 text-right" : "pr-3"} text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium whitespace-nowrap`}>
      {children}
    </th>
  );
}

function trendLabel(pct: number | null): string | undefined {
  if (pct == null) return undefined;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}% vs prior 7d`;
}
function trendTone(pct: number | null): "up" | "down" | undefined {
  if (pct == null) return undefined;
  return pct >= 0 ? "up" : "down";
}
function trendColor(pct: number | null): string | undefined {
  if (pct == null) return undefined;
  return pct >= 0 ? "var(--color-good)" : "var(--color-bad, #e5484d)";
}

function fmtUsd(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}
