import type { Benchmark, ProviderResult } from "@/data/benchmarks";
import { Sparkline } from "@/components/sparkline";
import { cn } from "@/lib/utils";
import { fmtUnit } from "@/lib/format";

type Props = {
  benchmark: Benchmark;
};

/**
 * The full-distribution provider table with sparklines, presented like a
 * stock-exchange ledger: column groups, hairline rules, alternating rows,
 * monospace numerals.
 */
export function LedgerTable({ benchmark }: Props) {
  const { results, unit, extras } = benchmark;
  const secondary = results[0]?.secondary?.label;

  // Global Y-bounds for the sparklines so all rows share the same scale.
  const allSeries = Object.values(extras.series24h).flat();
  const sparkMin = Math.min(...allSeries);
  const sparkMax = Math.max(...allSeries);

  return (
    <div className="overflow-x-auto">
      <table className="ledger w-full border-collapse text-sm tabular">
        <thead>
          <tr className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink">
            <th colSpan={2} className="border-y-2 border-ink py-2 pr-4 text-left font-medium">
              Provider
            </th>
            <th
              colSpan={4}
              className="border-y-2 border-ink py-2 pr-4 text-center font-medium"
            >
              Latency &nbsp;·&nbsp; {unit === "s" ? "seconds" : "milliseconds"}
            </th>
            <th className="border-y-2 border-ink py-2 pr-4 text-right font-medium">
              Reliability
            </th>
            <th className="border-y-2 border-ink py-2 pr-4 text-right font-medium">
              Trend (24h)
            </th>
            {secondary && (
              <th className="border-y-2 border-ink py-2 pr-4 text-right font-medium">
                {secondary}
              </th>
            )}
          </tr>
          <tr className="font-sans text-[10px] uppercase tracking-[0.12em] text-ink-muted">
            <th className="py-2 pr-4 text-left font-medium">№</th>
            <th className="py-2 pr-4 text-left font-medium">Name</th>
            <th className="py-2 pr-4 text-right font-medium">p50</th>
            <th className="py-2 pr-4 text-right font-medium">p90</th>
            <th className="py-2 pr-4 text-right font-medium">p99</th>
            <th className="py-2 pr-4 text-right font-medium">Mean</th>
            <th className="py-2 pr-4 text-right font-medium">Success</th>
            <th className="py-2 pr-4 text-right font-medium">P50 over 24h</th>
            {secondary && <th className="py-2 pr-4 text-right font-medium">Value</th>}
          </tr>
          <tr className="border-b border-ink">
            <th colSpan={9} className="h-px p-0" />
          </tr>
        </thead>
        <tbody className="font-mono">
          {results.map((r, i) => (
            <Row
              key={r.slug}
              r={r}
              i={i}
              unit={unit}
              hasSecondary={!!secondary}
              series={extras.series24h[r.slug] ?? []}
              sparkMin={sparkMin}
              sparkMax={sparkMax}
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
  hasSecondary,
  series,
  sparkMin,
  sparkMax,
}: {
  r: ProviderResult;
  i: number;
  unit: string;
  hasSecondary: boolean;
  series: number[];
  sparkMin: number;
  sparkMax: number;
}) {
  const isWinner = r.highlight === "winner";
  return (
    <tr className={cn("border-b border-rule", isWinner && "bg-paper-deep/60")}>
      <td className="py-3 pr-4 text-ink-muted">{String(i + 1).padStart(2, "0")}</td>
      <td className="py-3 pr-4 font-serif">
        <div className="flex items-baseline gap-2">
          <span className={cn("text-ink", isWinner ? "font-semibold" : "font-normal")}>
            {r.name}
          </span>
          {isWinner && (
            <span className="font-sans text-[9px] uppercase tracking-[0.18em] text-accent">
              Lead
            </span>
          )}
        </div>
        {r.tag && (
          <p className="mt-0.5 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-muted">
            {r.tag}
          </p>
        )}
      </td>
      <td className={cn("py-3 pr-4 text-right", isWinner && "font-semibold")}>
        {fmtUnit(r.ms.p50, unit)}
      </td>
      <td className="py-3 pr-4 text-right text-ink-soft">{fmtUnit(r.ms.p90, unit)}</td>
      <td className="py-3 pr-4 text-right text-ink-soft">{fmtUnit(r.ms.p99, unit)}</td>
      <td className="py-3 pr-4 text-right text-ink-soft">{fmtUnit(r.ms.mean, unit)}</td>
      <td className="py-3 pr-4 text-right text-ink-soft">
        {r.successRate.toFixed(2)}%
      </td>
      <td className="py-3 pr-4 text-right">
        <span className="inline-flex items-center justify-end">
          <Sparkline
            values={series}
            emphasis={isWinner}
            globalMin={sparkMin}
            globalMax={sparkMax}
          />
        </span>
      </td>
      {hasSecondary && (
        <td className="py-3 pr-4 text-right text-ink-soft">{r.secondary?.value ?? "—"}</td>
      )}
    </tr>
  );
}
