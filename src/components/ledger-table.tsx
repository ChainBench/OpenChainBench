import type { Benchmark, ProviderResult } from "@/types/benchmark";
import { Sparkline } from "@/components/sparkline";
import { cn } from "@/lib/utils";
import { fmtUnit } from "@/lib/format";
import { providerColor } from "@/lib/colors";

type Props = {
  benchmark: Benchmark;
};

export function LedgerTable({ benchmark }: Props) {
  const { results, unit, extras } = benchmark;
  const secondary = results[0]?.secondary?.label;

  const allSeries = Object.values(extras.series24h).flat();
  const sparkMin = allSeries.length ? Math.min(...allSeries) : 0;
  const sparkMax = allSeries.length ? Math.max(...allSeries) : 1;
  const leaderSlug = [...results].sort((a, b) => a.ms.p50 - b.ms.p50)[0]?.slug;

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular">
          <thead>
            <tr className="border-b border-rule bg-bg-soft text-[11px] uppercase tracking-[0.1em] text-ink-muted">
              <th className="py-3 px-5 text-left font-medium">Provider</th>
              <th className="py-3 px-3 text-right font-medium">p50</th>
              <th className="py-3 px-3 text-right font-medium">p90</th>
              <th className="py-3 px-3 text-right font-medium">p99</th>
              <th className="py-3 px-3 text-right font-medium">Mean</th>
              <th className="py-3 px-3 text-right font-medium">Success</th>
              <th className="py-3 px-3 text-right font-medium">24h trend</th>
              {secondary && (
                <th className="py-3 px-5 text-right font-medium">{secondary}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <Row
                key={r.slug}
                r={r}
                unit={unit}
                hasSecondary={!!secondary}
                series={extras.series24h[r.slug] ?? []}
                sparkMin={sparkMin}
                sparkMax={sparkMax}
                leaderSlug={leaderSlug}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({
  r,
  unit,
  hasSecondary,
  series,
  sparkMin,
  sparkMax,
  leaderSlug,
}: {
  r: ProviderResult;
  unit: string;
  hasSecondary: boolean;
  series: number[];
  sparkMin: number;
  sparkMax: number;
  leaderSlug?: string;
}) {
  const isWinner = leaderSlug === r.slug;
  const color = providerColor(r.slug);
  return (
    <tr className="border-b border-rule last:border-b-0">
      <td className="py-3.5 px-5">
        <div className="flex items-baseline gap-2">
          <span
            className={cn("text-sm font-semibold")}
            style={{ color }}
          >
            {r.name}
          </span>
          {isWinner && (
            <span
              className="rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em]"
              style={{
                color,
                backgroundColor: `${color}1f`,
              }}
            >
              Lead
            </span>
          )}
        </div>
        {r.tag && (
          <p className="mt-0.5 text-[11px] text-ink-muted">{r.tag}</p>
        )}
      </td>
      <td
        className={cn(
          "py-3.5 px-3 text-right font-mono tabular",
          isWinner ? "font-semibold" : "text-ink-soft"
        )}
        style={isWinner ? { color } : undefined}
      >
        {fmtUnit(r.ms.p50, unit)}
      </td>
      <td className="py-3.5 px-3 text-right font-mono tabular text-ink-soft">
        {fmtUnit(r.ms.p90, unit)}
      </td>
      <td className="py-3.5 px-3 text-right font-mono tabular text-ink-soft">
        {fmtUnit(r.ms.p99, unit)}
      </td>
      <td className="py-3.5 px-3 text-right font-mono tabular text-ink-soft">
        {fmtUnit(r.ms.mean, unit)}
      </td>
      <td className="py-3.5 px-3 text-right font-mono tabular text-ink-soft">
        {r.successRate.toFixed(2)}%
      </td>
      <td className="py-3.5 px-3 text-right">
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
        <td className="py-3.5 px-5 text-right font-mono tabular text-ink-soft">
          {r.secondary?.value ?? "—"}
        </td>
      )}
    </tr>
  );
}
