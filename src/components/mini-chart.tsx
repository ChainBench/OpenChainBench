import { useMemo } from "react";
import { buildProviderColors } from "@/lib/series-colors";

/**
 * Compact multi-line chart for bench cards. Same visual language as the
 * full TimeSeriesChart on the bench detail page. every provider gets a
 * line in their signature color. but stripped of axes, hover and tabs.
 * Reads `series24h` from the benchmark's `extras` payload.
 *
 * Structural prop type: accepts the full `Benchmark` (home table) and
 * the slim `BenchmarkCardData` projection (hub grid) so the hub doesn't
 * need to ship the full Benchmark shape (series7d, series30d,
 * metricPanels, editorial copy, ...) per card in the RSC payload.
 */

type MiniChartBenchmark = {
  results: { slug: string; name: string; ms: { p50: number } }[];
  higherIsBetter: boolean;
  extras: { series24h: Record<string, number[]> };
};

type Props = {
  benchmark: MiniChartBenchmark;
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
  const colors = useMemo(() => buildProviderColors(benchmark.results), [benchmark.results]);

  // Sort providers so the legend reads best → worst, matching the ledger
  // table on the detail page. Direction depends on the bench (lower vs
  // higher is better).
  const sortedResults = [...benchmark.results].sort(
    benchmark.higherIsBetter
      ? (a, b) => b.ms.p50 - a.ms.p50
      : (a, b) => a.ms.p50 - b.ms.p50,
  );

  const seriesList = sortedResults
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      values: downsample(benchmark.extras.series24h[r.slug] ?? [], 28),
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
              {/* Live pulse halo. animated outward */}
              <circle cx={lastX} cy={lastY} r={2} fill={color} opacity={0.35}>
                <animate
                  attributeName="r"
                  values="2;7;2"
                  dur="1.8s"
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0.45;0;0.45"
                  dur="1.8s"
                  repeatCount="indefinite"
                />
              </circle>
              {/* Solid endpoint */}
              <circle cx={lastX} cy={lastY} r={2.2} fill={color} />
            </g>
          );
        })}
      </svg>

      {legend && (() => {
        // Cap visible legend entries so dense benches (8+ providers, e.g.
        // solana-tx-landing market share) don't wrap to multiple lines and
        // overflow the chart column on the homepage table. Matches the
        // 4-chip cap in HomeBenchTable's title cell.
        const MAX_VISIBLE = 5;
        const visible = seriesList.slice(0, MAX_VISIBLE);
        const hidden = seriesList.length - visible.length;
        return (
          <ul className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-medium tabular leading-none">
            {visible.map((s) => (
              <li key={s.slug} className="inline-flex items-center gap-1.5 min-w-0">
                <span
                  className="inline-block h-[3px] w-3 rounded-sm shrink-0"
                  style={{ background: s.color }}
                  aria-hidden
                />
                <span
                  className="truncate max-w-[110px]"
                  style={{ color: s.color }}
                  title={s.name}
                >
                  {s.name}
                </span>
              </li>
            ))}
            {hidden > 0 && (
              <li
                className="text-ink-muted"
                title={seriesList.slice(MAX_VISIBLE).map((s) => s.name).join(", ")}
              >
                +{hidden} more
              </li>
            )}
          </ul>
        );
      })()}
    </div>
  );
}

// 48-px-tall sparkline can't render >~30 distinct points anyway. Bucket
// long series down so the rendered SVG path stays compact (each kept
// point is the bucket mean, preserving the shape that drove the polyline
// at full resolution). Cuts the /benchmarks HTML payload sharply when
// the grid is showing every bench's series at once.
function downsample(values: number[], target: number): number[] {
  if (values.length <= target) return values;
  const bucketSize = values.length / target;
  const out: number[] = [];
  for (let i = 0; i < target; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    let sum = 0;
    let n = 0;
    for (let j = start; j < end && j < values.length; j++) {
      sum += values[j];
      n++;
    }
    if (n > 0) out.push(sum / n);
  }
  return out;
}
