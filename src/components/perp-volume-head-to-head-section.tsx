import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  fmtUsdCompact,
  findVenue,
  getPerpVolumeHistory,
  headToHead,
  weeklyRatio,
} from "@/lib/perp-volume-history";
import { brandColor } from "@/lib/brand";
import { lineColor } from "@/lib/series-colors";
import { PerpVolumeHeadToHeadChart } from "@/components/perp-volume-head-to-head";
import { PerpVolumeRatioChart } from "@/components/perp-volume-ratio-chart";
import { ProviderLogo } from "@/components/provider-logo";

/**
 * Compare-page hero for two perp venues: daily perp volume head to head
 * from bench 266's history (closed UTC days, backfilled), above the
 * shared bench cards. Renders nothing when either venue is not in the
 * history or the read fails, so the compare page never depends on it.
 */
export async function PerpVolumeHeadToHead({
  aSlug,
  bSlug,
  aName,
  bName,
}: {
  aSlug: string;
  bSlug: string;
  aName: string;
  bName: string;
}) {
  const history = await getPerpVolumeHistory();
  if (!history) return null;
  const a = findVenue(history, aSlug);
  const b = findVenue(history, bSlug);
  if (!a || !b || a.days.length < 7 || b.days.length < 7) return null;
  const h2h = headToHead(a, b, 90);
  if (!h2h) return null;
  const ratio = weeklyRatio(a, b, h2h.asOf, 16);

  const aColor = brandColor(aSlug) ?? lineColor(0);
  const bColor = brandColor(bSlug) ?? lineColor(1);

  const rows: { label: string; a: number | null; b: number | null }[] = [
    { label: `Last closed day (${fmtDay(h2h.asOf)})`, ...h2h.window["1d"] },
    { label: "Last 7 days", ...h2h.window["7d"] },
    { label: "Last 30 days", ...h2h.window["30d"] },
  ];

  const streakName =
    h2h.streak.side === "a" ? aName : h2h.streak.side === "b" ? bName : null;
  const lead30 =
    h2h.window["30d"].a !== null && h2h.window["30d"].b !== null
      ? h2h.window["30d"].a > h2h.window["30d"].b
        ? aName
        : bName
      : null;
  const lead7 =
    h2h.window["7d"].a !== null && h2h.window["7d"].b !== null
      ? h2h.window["7d"].a > h2h.window["7d"].b
        ? aName
        : bName
      : null;

  return (
    <section className="mt-10" id="daily-volume">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
            Daily perp volume, head to head
          </h2>
          <div className="mt-2 flex items-center gap-3">
            <span className="inline-flex items-center gap-2 text-base font-medium text-ink">
              <ProviderLogo slug={aSlug} name={aName} size={26} />
              {aName}
            </span>
            <span className="text-sm text-ink-faint">vs</span>
            <span className="inline-flex items-center gap-2 text-base font-medium text-ink">
              <ProviderLogo slug={bSlug} name={bName} size={26} />
              {bName}
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Perpetual notional per closed UTC day, the DeFiLlama day buckets, read from each
            venue&apos;s own data. Ribbon under the bars marks which venue printed more that day.
          </p>
        </div>
        <Link
          href="/benchmarks/perp-daily-volume"
          className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink"
        >
          Bench 266, all venues <ArrowUpRight size={11} />
        </Link>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <Tile
          label="7d lead"
          value={lead7 ?? "n/a"}
          sub={
            h2h.window["7d"].a !== null && h2h.window["7d"].b !== null
              ? `${fmtUsdCompact(h2h.window["7d"].a)} vs ${fmtUsdCompact(h2h.window["7d"].b)}`
              : "window incomplete"
          }
          color={lead7 === aName ? aColor : lead7 === bName ? bColor : undefined}
        />
        <Tile
          label="30d lead"
          value={lead30 ?? "n/a"}
          sub={
            h2h.window["30d"].a !== null && h2h.window["30d"].b !== null
              ? `${fmtUsdCompact(h2h.window["30d"].a)} vs ${fmtUsdCompact(h2h.window["30d"].b)}`
              : "window incomplete"
          }
          color={lead30 === aName ? aColor : lead30 === bName ? bColor : undefined}
        />
        <Tile
          label="Days led, last 30"
          value={`${h2h.daysLed30.a} / ${h2h.daysLed30.b}`}
          sub={`${aName} / ${bName}`}
        />
        <Tile
          label="Current streak"
          value={streakName ? `${h2h.streak.days} ${h2h.streak.days === 1 ? "day" : "days"}` : "tie"}
          sub={streakName ? `${streakName} since ${fmtDay(h2h.streakSince ?? h2h.asOf)}` : "no lead on the last day"}
          color={h2h.streak.side === "a" ? aColor : h2h.streak.side === "b" ? bColor : undefined}
        />
      </div>

      <div className="mt-5 rounded border border-rule bg-paper p-4">
        <PerpVolumeHeadToHeadChart
          days={h2h.days}
          aName={aName}
          bName={bName}
          aColor={aColor}
          bColor={bColor}
        />
      </div>

      <div className="mt-5 rounded border border-rule bg-paper p-4">
        <p className="text-sm font-medium text-ink">
          {aName} volume ÷ {bName} volume, week by week
        </p>
        <p className="mb-3 mt-1 text-xs text-ink-muted">
          The ratio of the two venues&apos; seven-day perp volume, in percent; a window is shown only
          when both sides have every day closed. 100% is parity. The dashed line is the median of the
          weeks shown; the last window is the 7d tile above.
        </p>
        <PerpVolumeRatioChart
          points={ratio.points}
          medianPct={ratio.medianPct}
          aName={aName}
          bName={bName}
          color={aColor}
        />
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              <th className="py-1.5 pr-4 font-medium">Window</th>
              <th className="py-1.5 pr-4 font-medium" style={{ color: aColor }}>{aName}</th>
              <th className="py-1.5 pr-4 font-medium" style={{ color: bColor }}>{bName}</th>
              <th className="py-1.5 font-medium">{aName} / {bName}</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-rule">
                <td className="py-1.5 pr-4 text-ink-soft">{r.label}</td>
                <td className="py-1.5 pr-4 text-ink">{fmtUsdCompact(r.a)}</td>
                <td className="py-1.5 pr-4 text-ink">{fmtUsdCompact(r.b)}</td>
                <td className="py-1.5 text-ink">
                  {r.a !== null && r.b !== null && r.b > 0 ? `${((r.a / r.b) * 100).toFixed(0)}%` : "n/a"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        Sources: {aName}, {a.note ?? a.source}. {bName}, {b.note ?? b.source}. Days where either
        venue has not closed are left blank rather than counted as zero. Last closed day common to
        both: {fmtDay(h2h.asOf)}. Methodology and every venue on{" "}
        <Link href="/benchmarks/perp-daily-volume" className="underline hover:text-ink">
          bench 266
        </Link>
        .
      </p>
    </section>
  );
}

function Tile({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color?: string;
}) {
  return (
    <div className="rounded border border-rule bg-paper px-4 py-3">
      <p className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">{label}</p>
      <p className="mt-1 text-lg font-medium tabular-nums text-ink" style={color ? { color } : undefined}>
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-ink-muted">{sub}</p>
    </div>
  );
}

function fmtDay(iso: string): string {
  const [y, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}
