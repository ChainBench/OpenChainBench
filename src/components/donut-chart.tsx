"use client";

import type { Benchmark } from "@/types/benchmark";
import { ProviderLogo } from "@/components/provider-logo";
import { buildProviderColors } from "@/lib/series-colors";

/**
 * Share-of-total donut. Each provider gets a slice proportional to its
 * p50 value vs the sum of every live provider's p50. Reads well on count
 * benches with market-share semantics (solana-tx-landing) and acceptably
 * on coverage benches (network-coverage) where slices show relative
 * footprint rather than market share.
 *
 * Unavailable providers and zero-valued rows are skipped so they don't
 * eat the legend without contributing to the total.
 */
export function DonutChart({ benchmark }: { benchmark: Benchmark }) {
  const { results } = benchmark;

  const live = results.filter(
    (r) => r.availability !== "unavailable" && r.ms.p50 > 0,
  );
  const total = live.reduce((s, r) => s + r.ms.p50, 0);
  if (live.length === 0 || total <= 0) {
    return (
      <p className="label-mono text-ink-faint py-8 text-center">
        No live samples in this view yet.
      </p>
    );
  }

  const sorted = [...live].sort((a, b) => b.ms.p50 - a.ms.p50);
  const colors = buildProviderColors(results);

  // SVG donut math. center 100,100; outer r=92; inner r=58.
  const cx = 100;
  const cy = 100;
  const rOuter = 92;
  const rInner = 58;
  // Start at 12 o'clock (-90°), proceed clockwise.
  let currentAngle = -Math.PI / 2;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-4">
        <p className="label-mono text-ink-faint">
          Share of field · by p50
        </p>
        <p className="label-mono text-ink-faint tabular hidden sm:block">
          {sorted.length} providers
        </p>
      </div>
      <div className="flex flex-col sm:flex-row sm:items-center gap-6 sm:gap-8">
        <svg
          viewBox="0 0 200 200"
          width="220"
          height="220"
          className="shrink-0 mx-auto sm:mx-0"
          aria-label={`Donut chart showing each provider's share across ${sorted.length} providers`}
        >
          {sorted.map((r) => {
            const share = r.ms.p50 / total;
            const sweep = share * Math.PI * 2;
            const a0 = currentAngle;
            const a1 = currentAngle + sweep;
            currentAngle = a1;
            const color = colors.get(r.slug) ?? "var(--color-ink-soft)";
            // Render every slice with a tiny inset (1°) so adjacent
            // slices are visually separated even at high density.
            return (
              <path
                key={r.slug}
                d={arcPath(cx, cy, rOuter, rInner, a0, a1)}
                fill={color}
                opacity={0.92}
              >
                <title>
                  {r.name}: {(share * 100).toFixed(1)}%
                </title>
              </path>
            );
          })}
          {/* Inner ring for visual depth */}
          <circle
            cx={cx}
            cy={cy}
            r={rInner}
            fill="var(--color-surface, #fff)"
          />
          <text
            x={cx}
            y={cy - 4}
            textAnchor="middle"
            className="font-serif"
            style={{ fontSize: 13, fill: "var(--color-ink-muted)" }}
          >
            {sorted.length}
          </text>
          <text
            x={cx}
            y={cy + 12}
            textAnchor="middle"
            className="label-mono"
            style={{ fontSize: 9, fill: "var(--color-ink-faint)" }}
          >
            PROVIDERS
          </text>
        </svg>
        <ul className="flex-1 flex flex-col gap-1.5 min-w-0">
          {sorted.map((r) => {
            const share = r.ms.p50 / total;
            const color = colors.get(r.slug) ?? "var(--color-ink-soft)";
            return (
              <li
                key={r.slug}
                className="flex items-center gap-2 text-[12px] min-w-0"
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ background: color }}
                  aria-hidden
                />
                <ProviderLogo slug={r.slug} name={r.name} size={16} />
                <span
                  className="font-serif font-semibold truncate"
                  style={{ color }}
                >
                  {r.name}
                </span>
                <span className="ml-auto tabular text-ink-muted shrink-0">
                  {(share * 100).toFixed(1)}%
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// Build an SVG annular-sector path. Handles the > 180° large-arc flag.
function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  a0: number,
  a1: number,
): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0o = cx + rOuter * Math.cos(a0);
  const y0o = cy + rOuter * Math.sin(a0);
  const x1o = cx + rOuter * Math.cos(a1);
  const y1o = cy + rOuter * Math.sin(a1);
  const x0i = cx + rInner * Math.cos(a1);
  const y0i = cy + rInner * Math.sin(a1);
  const x1i = cx + rInner * Math.cos(a0);
  const y1i = cy + rInner * Math.sin(a0);
  return [
    `M ${x0o.toFixed(2)} ${y0o.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x1o.toFixed(2)} ${y1o.toFixed(2)}`,
    `L ${x0i.toFixed(2)} ${y0i.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x1i.toFixed(2)} ${y1i.toFixed(2)}`,
    "Z",
  ].join(" ");
}
