import type { Benchmark, ProviderResult } from "@/types/benchmark";
import { Sparkline } from "@/components/sparkline";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";

type Props = {
  benchmark: Benchmark;
};

/**
 * Dense KPI ledger. every provider rendered in its signature color
 * (matched to the time-series chart) so a reader can scan rows and lines
 * without re-reading the legend. The colour assignment is purely an aid
 * to recognition; sort order remains mechanical (ascending p50) and no
 * row is highlighted as the "winner".
 */
export function LedgerTable({ benchmark }: Props) {
  const { results, unit, extras } = benchmark;
  const secondary = results[0]?.secondary?.label;
  const sorted = [...results].sort(
    benchmark.higherIsBetter
      ? (a, b) => b.ms.p50 - a.ms.p50
      : (a, b) => a.ms.p50 - b.ms.p50,
  );
  const colors = buildProviderColors(results);

  const allSeries = Object.values(extras.series24h).flat();
  const sparkMin = allSeries.length ? Math.min(...allSeries) : 0;
  const sparkMax = allSeries.length ? Math.max(...allSeries) : 1;

  // Maximum p50 across the field. used to size the inline data bar
  const maxP50 = Math.max(...results.map((r) => r.ms.p50)) || 1;

  const fieldP50 =
    results.reduce((s, r) => s + r.ms.p50, 0) / Math.max(1, results.length);

  return (
    <div className="overflow-x-auto">
      <table className="ledger w-full border-collapse">
        <thead>
          <tr>
            <th colSpan={3} className="border-y-2 border-ink py-2 pr-3 text-left">
              Provider
            </th>
            <th colSpan={4} className="border-y-2 border-ink py-2 px-3 text-center">
              Latency aggregates
            </th>
            <th colSpan={3} className="border-y-2 border-ink py-2 px-3 text-center">
              24-hour range
            </th>
            <th colSpan={2} className="border-y-2 border-ink py-2 pl-3 text-right">
              Reliability
            </th>
            <th className="border-y-2 border-ink py-2 pl-3 text-right">Trend</th>
            {secondary && (
              <th className="border-y-2 border-ink py-2 pl-3 text-right">
                {secondary}
              </th>
            )}
          </tr>
          <tr>
            <th className="py-2 pr-2 text-left w-2"></th>
            <th className="py-2 pr-3 text-left w-10">№</th>
            <th className="py-2 pr-3 text-left">Name</th>
            <th className="py-2 px-3 text-right">p50</th>
            <th className="py-2 px-3 text-right">p90</th>
            <th className="py-2 px-3 text-right">p99</th>
            <th className="py-2 px-3 text-right">Mean</th>
            <th className="py-2 px-3 text-right">Min</th>
            <th className="py-2 px-3 text-right">Max</th>
            <th className="py-2 px-3 text-right">Δ field</th>
            <th className="py-2 px-3 text-right">Success</th>
            <th className="py-2 px-3 text-right">n</th>
            <th className="py-2 pl-3 text-right">24h</th>
            {secondary && <th className="py-2 pl-3 text-right">Value</th>}
          </tr>
          <tr className="border-b border-ink">
            <th colSpan={14} className="h-px p-0" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <Row
              key={r.slug}
              r={r}
              i={i}
              unit={unit}
              fieldP50={fieldP50}
              maxP50={maxP50}
              hasSecondary={!!secondary}
              series={extras.series24h[r.slug] ?? []}
              sparkMin={sparkMin}
              sparkMax={sparkMax}
              color={colors.get(r.slug) ?? "var(--color-ink-soft)"}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  r,
  i,
  unit,
  fieldP50,
  maxP50,
  hasSecondary,
  series,
  sparkMin,
  sparkMax,
  color,
}: {
  r: ProviderResult;
  i: number;
  unit: string;
  fieldP50: number;
  maxP50: number;
  hasSecondary: boolean;
  series: number[];
  sparkMin: number;
  sparkMax: number;
  color: string;
}) {
  const seriesMin = series.length ? Math.min(...series) : r.ms.p50;
  const seriesMax = series.length ? Math.max(...series) : r.ms.p99;
  const deltaPct = fieldP50 > 0 ? ((r.ms.p50 - fieldP50) / fieldP50) * 100 : 0;
  const deltaSign = deltaPct > 0 ? "+" : deltaPct < 0 ? "−" : "±";
  // Inline p50 bar width relative to the field max
  const barPct = Math.max(2, (r.ms.p50 / maxP50) * 100);

  return (
    <tr className="border-b border-rule transition-colors hover:bg-paper-soft/50">
      {/* Color accent. left edge of row */}
      <td
        className="p-0 align-middle"
        style={{ width: 4 }}
      >
        <span
          className="block w-[3px] h-7 rounded-sm"
          style={{ background: color }}
          aria-hidden
        />
      </td>
      <td className="py-2.5 pr-3 text-ink-muted text-[12px]">
        {String(i + 1).padStart(2, "0")}
      </td>
      <td className="py-2.5 pr-3 font-serif text-[14px]">
        <span className="font-semibold" style={{ color }}>
          {r.name}
        </span>
        {r.tag && (
          <span className="ml-2 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-muted">
            {r.tag}
          </span>
        )}
      </td>
      {/* p50 with inline data bar */}
      <td className="py-2.5 px-3 text-right">
        <span className="inline-flex items-center gap-2 justify-end">
          <span
            className="hidden sm:inline-block h-1.5 rounded-sm"
            style={{
              width: `${barPct * 0.45}px`,
              background: `${color}26`, // 15% alpha
              borderLeft: `2px solid ${color}`,
            }}
            aria-hidden
          />
          <span className="text-ink whitespace-nowrap">
            {fmtUnit(r.ms.p50, unit)}
          </span>
        </span>
      </td>
      <td className="py-2.5 px-3 text-right text-ink-soft">
        {fmtUnit(r.ms.p90, unit)}
      </td>
      <td className="py-2.5 px-3 text-right text-ink-soft">
        {fmtUnit(r.ms.p99, unit)}
      </td>
      <td className="py-2.5 px-3 text-right text-ink-soft">
        {fmtUnit(r.ms.mean, unit)}
      </td>
      <td className="py-2.5 px-3 text-right text-ink-soft">
        {fmtUnit(seriesMin, unit)}
      </td>
      <td className="py-2.5 px-3 text-right text-ink-soft">
        {fmtUnit(seriesMax, unit)}
      </td>
      <td className="py-2.5 px-3 text-right text-ink-muted">
        {fieldP50 > 0 ? `${deltaSign}${Math.abs(deltaPct).toFixed(0)}%` : "—"}
      </td>
      <td className="py-2.5 px-3 text-right text-ink-soft">
        {r.successRate.toFixed(2)}%
      </td>
      <td className="py-2.5 px-3 text-right text-ink-muted">
        {r.sampleSize ? Math.round(r.sampleSize).toLocaleString() : "—"}
      </td>
      <td className="py-2.5 pl-3 text-right">
        <span className="inline-flex items-center justify-end">
          <Sparkline
            values={series}
            color={color}
            globalMin={sparkMin}
            globalMax={sparkMax}
          />
        </span>
      </td>
      {hasSecondary && (
        <td className="py-2.5 pl-3 text-right text-ink-soft">
          {r.secondary?.value ?? "—"}
        </td>
      )}
    </tr>
  );
}
