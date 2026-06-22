"use client";

import { useState } from "react";
import type { PmCategoryShare } from "@/lib/pm-venue-data";

/**
 * 5-slice donut: Politics / Sports / Crypto / Macro / Other, sized by
 * 30d volume share. Same arc-path idiom as `hl-coin-distribution`, but
 * the palette is the PM teal/cyan/indigo/violet/slate set so the section
 * reads consistently with the rest of /prediction-markets.
 *
 * No external dependency; the SVG is computed on the fly. Hover swaps
 * the centre label and dims the other slices for clarity.
 */

const PALETTE: Record<PmCategoryShare["category"], string> = {
  Politics: "#14b8a6",
  Sports: "#06b6d4",
  Crypto: "#6366f1",
  Macro: "#8b5cf6",
  Other: "#64748b",
};

const ORDER: PmCategoryShare["category"][] = [
  "Politics",
  "Sports",
  "Crypto",
  "Macro",
  "Other",
];

export function PmCategoryDonut({
  shares,
}: {
  shares: PmCategoryShare[] | null;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  if (!shares || shares.length === 0) return null;

  // Re-order to a stable list so the donut always reads Politics → Other.
  const ordered = ORDER.map(
    (c) => shares.find((s) => s.category === c) ?? { category: c, share: 0 },
  ).filter((s) => s.share > 0);

  const total = ordered.reduce((a, s) => a + s.share, 0);
  if (total <= 0) return null;

  const cx = 100;
  const cy = 100;
  const rOuter = 92;
  const rInner = 64;

  const sweeps = ordered.map((s) => (s.share / total) * Math.PI * 2);
  const starts: number[] = [];
  sweeps.reduce((acc, sw) => {
    starts.push(acc);
    return acc + sw;
  }, -Math.PI / 2);

  const slices = ordered.map((s, i) => ({
    ...s,
    a0: starts[i],
    a1: starts[i] + sweeps[i],
    color: PALETTE[s.category],
  }));

  const leader = [...slices].sort((a, b) => b.share - a.share)[0];
  const hoveredSlice = hovered
    ? slices.find((s) => s.category === hovered) ?? null
    : null;
  const centre = hoveredSlice ?? leader;

  return (
    <div className="card-soft rounded-xl p-4 sm:p-6 border border-ink/10">
      <div className="mb-3">
        <p
          className="label-mono text-[10px] text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          Category split · 30d
        </p>
        <p className="text-sm text-ink-faint mt-0.5">
          Share of 30d volume by market category
        </p>
      </div>

      <div className="flex flex-col items-center sm:flex-row sm:items-center sm:justify-center gap-4 sm:gap-6">
        <div
          className="relative shrink-0 mx-auto sm:mx-0"
          style={{ width: "min(100%, 180px)", maxWidth: 180 }}
        >
          <svg
            viewBox="0 0 200 200"
            width="100%"
            height="auto"
            aria-label="Category volume share"
            onMouseLeave={() => setHovered(null)}
          >
            {slices.map((s) => {
              const dim = hovered !== null && hovered !== s.category;
              return (
                <path
                  key={s.category}
                  d={arcPath(cx, cy, rOuter, rInner, s.a0, s.a1)}
                  fill={s.color}
                  stroke="var(--color-paper, #fff)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  style={{
                    opacity: dim ? 0.3 : 1,
                    transition: "opacity 140ms ease-out",
                    cursor: "pointer",
                  }}
                  onMouseEnter={() => setHovered(s.category)}
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
              {hoveredSlice ? "of 30d volume" : "leading category"}
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
              {centre.category}
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
              {(centre.share * 100).toFixed(1)}%
            </text>
          </svg>
        </div>

        <ul className="w-full sm:w-auto sm:max-w-[200px] min-w-0 flex flex-col gap-1">
          {slices.map((s) => {
            const isHovered = hovered === s.category;
            return (
              <li
                key={s.category}
                onMouseEnter={() => setHovered(s.category)}
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
                <span className="text-[12px] font-medium text-ink truncate">
                  {s.category}
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
