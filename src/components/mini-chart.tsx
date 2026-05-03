import type { Benchmark } from "@/types/benchmark";
import { buildProviderColors } from "@/lib/series-colors";

/**
 * Compact multi-line chart for bench cards. Same visual language as the
 * full TimeSeriesChart on the bench detail page — every provider gets a
 * line in their signature color — but stripped of axes, hover and tabs.
 * Reads `series24h` from the benchmark's `extras` payload.
 */

type Props = {
  benchmark: Benchmark;
  /** Internal viewBox width used for path math. Visual width is 100% of parent. */
  viewBoxWidth?: number;
  height?: number;
  className?: string;
  /** Render a compact legend (provider name in their color) below the chart. */
  legend?: boolean;
};

export function MiniChart({
  benchmark,
  viewBoxWidth = 400,
  height = 56,
  className = "",
  legend = false,
}: Props) {
  const width = viewBoxWidth;
  const colors = buildProviderColors(benchmark.results);

  // Sort providers ascending by p50 so the legend reads in the same order
  // as the ledger table on the detail page (best → worst).
  const sortedResults = [...benchmark.results].sort(
    (a, b) => a.ms.p50 - b.ms.p50
  );

  const seriesList = sortedResults
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      values: benchmark.extras.series24h[r.slug] ?? [],
      color: colors.get(r.slug) ?? "var(--color-ink-soft)",
    }))
    .filter((s) => s.values.length > 1);

  if (seriesList.length === 0) return null;

  // Shared scale across providers so magnitudes are directly comparable.
  const all = seriesList.flatMap((s) => s.values);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min || 1;

  // Take the longest series to anchor the X-axis grid.
  const maxLen = Math.max(...seriesList.map((s) => s.values.length));

  return (
    <div className={className}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="overflow-visible"
        aria-hidden
      >
        {seriesList.map(({ slug, values, color }) => {
          const points = values
            .map((v, i) => {
              const x = (i / Math.max(1, maxLen - 1)) * width;
              const y = height - ((v - min) / range) * (height - 4) - 2;
              return `${x.toFixed(2)},${y.toFixed(2)}`;
            })
            .join(" ");

          const last = values[values.length - 1];
          const lastX = ((values.length - 1) / Math.max(1, maxLen - 1)) * width;
          const lastY = height - ((last - min) / range) * (height - 4) - 2;

          return (
            <g key={slug}>
              <polyline
                fill="none"
                stroke={color}
                strokeWidth={1.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeOpacity={0.85}
                vectorEffect="non-scaling-stroke"
                points={points}
              />
              <circle cx={lastX} cy={lastY} r={1.8} fill={color} />
            </g>
          );
        })}
      </svg>

      {legend && (
        <ul className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-medium tabular leading-none">
          {seriesList.map((s) => (
            <li key={s.slug} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-[3px] w-3 rounded-sm"
                style={{ background: s.color }}
                aria-hidden
              />
              <span style={{ color: s.color }}>{s.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
