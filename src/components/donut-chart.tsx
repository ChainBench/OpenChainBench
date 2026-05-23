"use client";

import { type ReactNode, useMemo, useState } from "react";
import type { Benchmark } from "@/types/benchmark";
import { liveResults } from "@/lib/provider-filters";
import { ProviderLogo } from "@/components/provider-logo";
import { fmtUnit } from "@/lib/format";
import { methodologyTooltip } from "@/lib/methodology-tooltip";
import { buildProviderColors } from "@/lib/series-colors";
import { useChartExclusion } from "@/hooks/use-chart-exclusion";

/**
 * Share-of-field donut. Each provider is a slice sized by p50 vs the
 * field's total p50.
 *
 * Design choices borrowed from Linear Insights / Vercel Analytics /
 * Stripe Sigma after a design review pointed out the prior version
 * read as amateur:
 *
 *   - Donut at 280 px desktop / 220 px mobile, ring width ~22 % of
 *     radius. The earlier 220 px circle was undersized for 10-15
 *     slices and gave the legend too much horizontal weight.
 *   - opacity:1 on slices + 2 px paper-coloured stroke for separation,
 *     not a half-opaque fill that muddies the palette.
 *   - Hover highlights the hovered slice + dims the others to 0.35,
 *     and the inner-ring text swaps from the field total to the
 *     hovered provider's name / value / %. This kills the need for a
 *     floating tooltip while keeping the data 100 % discoverable.
 *   - Legend is sans-serif (was serif), 2-column when there are more
 *     than 8 providers, with a small colour chip + tabular percentage.
 */

const RING_DESKTOP = 280;

export function DonutChart({
  benchmark,
  excluded: controlledExcluded,
  onToggleExclude,
  headerActions,
}: {
  benchmark: Benchmark;
  excluded?: Set<string>;
  onToggleExclude?: (slug: string) => void;
  headerActions?: ReactNode;
}) {
  const { results } = benchmark;
  const { excluded, toggle } = useChartExclusion(
    controlledExcluded,
    onToggleExclude,
  );

  const liveAll = useMemo(
    () => liveResults(results),
    [results],
  );
  const live = liveAll.filter((r) => !excluded.has(r.slug));
  const total = live.reduce((s, r) => s + r.ms.p50, 0);
  const colors = useMemo(() => buildProviderColors(results), [results]);
  const sorted = useMemo(
    () => [...live].sort((a, b) => b.ms.p50 - a.ms.p50),
    [live],
  );

  const [hovered, setHovered] = useState<string | null>(null);
  const hoveredResult = hovered
    ? liveAll.find((r) => r.slug === hovered) ?? null
    : null;
  const hoveredShare =
    hoveredResult && total > 0 ? hoveredResult.ms.p50 / total : 0;

  if (sorted.length === 0 || total <= 0) {
    return <p className="text-[12px] text-ink-faint py-8 text-center">No data.</p>;
  }

  // Donut geometry. The svg uses a viewBox so we can scale via width on
  // the wrapper without recomputing math.
  const cx = 100;
  const cy = 100;
  const rOuter = 92;
  const rInner = 68; // ring width 24 = ~26% of radius, sits in the canonical 20-25% band
  let currentAngle = -Math.PI / 2;
  const slices = sorted.map((r) => {
    const share = r.ms.p50 / total;
    const sweep = share * Math.PI * 2;
    const a0 = currentAngle;
    const a1 = currentAngle + sweep;
    currentAngle = a1;
    return { r, share, a0, a1, color: colors.get(r.slug) ?? "var(--color-ink-soft)" };
  });

  // Inner-ring centre label. Defaults to "Leader · p50". When the reader
  // hovers a slice the same lines swap to that slice's identity so the
  // eye doesn't have to jump to a separate tooltip.
  const leader = sorted[0];
  const centre = hoveredResult
    ? {
        name: hoveredResult.name,
        value: fmtUnit(hoveredResult.ms.p50, benchmark.unit),
        pct: `${(hoveredShare * 100).toFixed(1)}%`,
      }
    : {
        name: leader.name,
        value: fmtUnit(leader.ms.p50, benchmark.unit),
        pct: `${((leader.ms.p50 / total) * 100).toFixed(1)}%`,
      };

  const legendCols = liveAll.length > 8 ? "grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1" : "flex flex-col gap-1";

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-3 mb-5 min-h-7">
        <p className="text-[11px] font-sans font-medium uppercase tracking-[0.18em] text-ink-faint">
          Share by p50
        </p>
        <div className="flex items-center gap-3">
          <p className="text-[11px] font-mono tabular text-ink-faint">
            {live.length} of {liveAll.length} live
          </p>
          {headerActions}
        </div>
      </div>
      <div className="flex flex-col items-center md:flex-row md:items-center gap-6 md:gap-10">
        <div
          className="relative shrink-0 mx-auto md:mx-0"
          style={{
            width: "min(100%, " + RING_DESKTOP + "px)",
            maxWidth: RING_DESKTOP,
          }}
        >
          <svg
            viewBox="0 0 200 200"
            width="100%"
            height="auto"
            aria-label={`Share of total p50 across ${sorted.length} providers`}
            style={{ maxHeight: RING_DESKTOP }}
            onMouseLeave={() => setHovered(null)}
          >
            {slices.map(({ r, a0, a1, color }) => {
              const isDimmed = hovered !== null && hovered !== r.slug;
              return (
                <path
                  key={r.slug}
                  d={arcPath(cx, cy, rOuter, rInner, a0, a1)}
                  fill={color}
                  stroke="var(--color-paper)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  style={{
                    opacity: isDimmed ? 0.3 : 1,
                    transition: "opacity 140ms ease-out",
                    cursor: "pointer",
                  }}
                  onMouseEnter={() => setHovered(r.slug)}
                  onClick={() => toggle(r.slug)}
                >
                  <title>{methodologyTooltip(r, false)}</title>
                </path>
              );
            })}
            {/* Centre label, swaps to hovered provider on hover. */}
            <text
              x={cx}
              y={cy - 14}
              textAnchor="middle"
              style={{
                fontSize: 10,
                fontFamily: "var(--font-sans, sans-serif)",
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                fill: "var(--color-ink-faint)",
              }}
            >
              {hovered ? "Hovered" : "Leader"}
            </text>
            <text
              x={cx}
              y={cy + 4}
              textAnchor="middle"
              style={{
                fontSize: 14,
                fontFamily: "var(--font-sans, sans-serif)",
                fontWeight: 600,
                fill: "var(--color-ink)",
              }}
            >
              {truncateMiddle(centre.name, 16)}
            </text>
            <text
              x={cx}
              y={cy + 22}
              textAnchor="middle"
              style={{
                fontSize: 12,
                fontFamily: "var(--font-mono, monospace)",
                fill: "var(--color-ink-soft)",
              }}
            >
              {centre.value} · {centre.pct}
            </text>
          </svg>
        </div>
        <ul className={`flex-1 min-w-0 ${legendCols}`}>
          {liveAll
            .slice()
            .sort((a, b) => b.ms.p50 - a.ms.p50)
            .map((r) => {
              const isOff = excluded.has(r.slug);
              const share = isOff ? 0 : r.ms.p50 / total;
              const color = colors.get(r.slug) ?? "var(--color-ink-soft)";
              const isHovered = hovered === r.slug;
              return (
                <li
                  key={r.slug}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isOff}
                  title={methodologyTooltip(r, isOff)}
                  onMouseEnter={() => !isOff && setHovered(r.slug)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => toggle(r.slug)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(r.slug);
                    }
                  }}
                  className={`flex items-center gap-2.5 min-w-0 cursor-pointer rounded px-1.5 py-1 transition-colors ${
                    isHovered ? "bg-paper-soft/70" : "hover:bg-paper-soft/40"
                  } ${isOff ? "opacity-40" : ""}`}
                >
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ background: color }}
                    aria-hidden
                  />
                  <ProviderLogo slug={r.slug} name={r.name} size={16} />
                  <span
                    className={`font-sans font-medium text-[12.5px] truncate ${
                      isOff ? "line-through decoration-1 text-ink-faint" : "text-ink"
                    }`}
                  >
                    {r.name}
                  </span>
                  <span className="ml-auto font-mono tabular text-[11.5px] text-ink-soft shrink-0">
                    {isOff ? "—" : `${(share * 100).toFixed(1)}%`}
                  </span>
                </li>
              );
            })}
        </ul>
      </div>
    </div>
  );
}

// Annular sector. The `large-arc-flag` flips beyond a half-turn so a
// dominant slice (>50 %) still renders.
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

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const left = Math.ceil((max - 1) / 2);
  const right = Math.floor((max - 1) / 2);
  return s.slice(0, left) + "…" + s.slice(s.length - right);
}
