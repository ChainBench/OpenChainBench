"use client";

import { useState } from "react";
import type { CoinShare } from "@/lib/hl-builder-stats";

/**
 * 24h notional volume split by coin. Donut + legend, same idiom as the
 * bench's DonutChart but stripped of the Benchmark/exclusion machinery
 * since this view shows a single builder.
 *
 * Top-15 coins plus an "other" bucket. The harness already enforces
 * that cardinality on the Prom side, so we just render whatever it
 * gives us. Hover swaps the centre label to the hovered coin.
 */

const PALETTE = [
  "#9d65ff",
  "#ff8a3d",
  "#3fbfbf",
  "#f5b53a",
  "#5c8fff",
  "#e85aaa",
  "#5fce8a",
  "#c46bff",
  "#ff6f6f",
  "#52c2ee",
  "#f3a04b",
  "#7c81ff",
  "#48b06b",
  "#ff5c8a",
  "#a8a8a8",
  "#cccccc",
];
const OTHER_COLOR = "#cfcad6";

export function HlCoinDistribution({ shares }: { shares: CoinShare[] }) {
  const [hovered, setHovered] = useState<string | null>(null);

  if (shares.length === 0) return null;

  const totalShare = shares.reduce((s, c) => s + c.share, 0);
  if (totalShare <= 0) return null;

  const cx = 100;
  const cy = 100;
  const rOuter = 92;
  const rInner = 64;

  // Pre-compute angles. We share the same -π/2 starting point so the
  // first slice begins at 12 o'clock, matching the DonutChart in the
  // benches and avoiding a "rotation drift" perception across views.
  // Cumulative-sum via reduce to satisfy the no-mutation-after-render
  // rule (a plain `let angle` accumulator would trip react-hooks).
  const sweeps = shares.map((s) => (s.share / totalShare) * Math.PI * 2);
  const starts: number[] = [];
  sweeps.reduce((acc, sw) => {
    starts.push(acc);
    return acc + sw;
  }, -Math.PI / 2);
  const slices = shares.map((s, i) => ({
    ...s,
    a0: starts[i],
    a1: starts[i] + sweeps[i],
    color: s.coin === "other" ? OTHER_COLOR : PALETTE[i % PALETTE.length],
  }));

  const hoveredSlice = hovered
    ? slices.find((s) => s.coin === hovered) ?? null
    : null;

  const leader = slices[0];
  const centre = hoveredSlice
    ? {
        label: hoveredSlice.coin === "other" ? "Other" : hoveredSlice.coin,
        value: `${(hoveredSlice.share * 100).toFixed(1)}%`,
        sub: hoveredSlice.coin === "other" ? "outside top 15" : "of 24h volume",
      }
    : {
        label: leader.coin === "other" ? "Other" : leader.coin,
        value: `${(leader.share * 100).toFixed(1)}%`,
        sub: "top coin · 24h",
      };

  const legendCols =
    slices.length > 8
      ? "grid grid-cols-2 gap-x-5 gap-y-1"
      : "flex flex-col gap-1";

  return (
    <div className="card-soft rounded-xl p-4 sm:p-6 border border-ink/10">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
        <div>
          <p className="label-mono text-[10px] text-ink-faint">
            Coin volume distribution · 24h
          </p>
          <p className="text-sm text-ink-faint mt-0.5">
            Share of 24h notional volume by perp
          </p>
        </div>
      </div>

      <div className="flex flex-col items-center md:flex-row md:items-center gap-5 md:gap-8">
        <div
          className="relative shrink-0 mx-auto md:mx-0"
          style={{ width: "min(100%, 240px)", maxWidth: 240 }}
        >
          <svg
            viewBox="0 0 200 200"
            width="100%"
            height="auto"
            aria-label="Coin volume share"
            onMouseLeave={() => setHovered(null)}
          >
            {slices.map((s) => {
              const isDimmed = hovered !== null && hovered !== s.coin;
              return (
                <path
                  key={s.coin}
                  d={arcPath(cx, cy, rOuter, rInner, s.a0, s.a1)}
                  fill={s.color}
                  stroke="var(--color-paper, #fff)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  style={{
                    opacity: isDimmed ? 0.3 : 1,
                    transition: "opacity 140ms ease-out",
                    cursor: "pointer",
                  }}
                  onMouseEnter={() => setHovered(s.coin)}
                />
              );
            })}
            <text
              x={cx}
              y={cy - 10}
              textAnchor="middle"
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 9,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                fill: "var(--color-ink-faint)",
              }}
            >
              {centre.sub}
            </text>
            <text
              x={cx}
              y={cy + 8}
              textAnchor="middle"
              style={{
                fontSize: 18,
                fontWeight: 600,
                fill: "var(--color-ink)",
              }}
            >
              {centre.label}
            </text>
            <text
              x={cx}
              y={cy + 26}
              textAnchor="middle"
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 12,
                fill: "var(--color-ink-soft)",
              }}
            >
              {centre.value}
            </text>
          </svg>
        </div>

        <ul className={`flex-1 min-w-0 ${legendCols}`}>
          {slices.map((s) => {
            const isHovered = hovered === s.coin;
            return (
              <li
                key={s.coin}
                onMouseEnter={() => setHovered(s.coin)}
                onMouseLeave={() => setHovered(null)}
                className={`flex items-center gap-2.5 min-w-0 cursor-default rounded px-1.5 py-1 transition-colors ${
                  isHovered ? "bg-paper-soft/70" : "hover:bg-paper-soft/40"
                }`}
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ background: s.color }}
                  aria-hidden
                />
                <span
                  className={`text-[12px] truncate ${
                    s.coin === "other"
                      ? "italic text-ink-soft"
                      : "font-medium text-ink"
                  }`}
                  style={
                    s.coin !== "other"
                      ? { fontFamily: "var(--font-mono, monospace)" }
                      : undefined
                  }
                >
                  {s.coin === "other" ? "Other" : s.coin}
                </span>
                <span
                  className="ml-auto tabular-nums text-[11.5px] text-ink-soft shrink-0"
                  style={{ fontFamily: "var(--font-mono, monospace)" }}
                >
                  {(s.share * 100).toFixed(1)}%
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  a0: number,
  a1: number,
): string {
  const sweep = a1 - a0;
  if (sweep >= Math.PI * 2 - 1e-6) {
    return [
      `M ${(cx + rOuter).toFixed(2)} ${cy.toFixed(2)}`,
      `A ${rOuter} ${rOuter} 0 1 1 ${(cx - rOuter).toFixed(2)} ${cy.toFixed(2)}`,
      `A ${rOuter} ${rOuter} 0 1 1 ${(cx + rOuter).toFixed(2)} ${cy.toFixed(2)}`,
      `M ${(cx + rInner).toFixed(2)} ${cy.toFixed(2)}`,
      `A ${rInner} ${rInner} 0 1 0 ${(cx - rInner).toFixed(2)} ${cy.toFixed(2)}`,
      `A ${rInner} ${rInner} 0 1 0 ${(cx + rInner).toFixed(2)} ${cy.toFixed(2)}`,
      "Z",
    ].join(" ");
  }
  const large = sweep > Math.PI ? 1 : 0;
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
