"use client";

import { useMemo, useState } from "react";
import type { HeadToHeadDay } from "@/lib/perp-volume-history";

/**
 * Day-by-day perp volume for two venues over one span: paired bars per
 * UTC day plus a lead ribbon underneath (which side printed more that
 * day). Pure SVG, hover crosshair, no library. Server wrapper is
 * `PerpVolumeHeadToHead` in perp-volume-head-to-head-section.tsx.
 */
export function PerpVolumeHeadToHeadChart({
  days,
  aName,
  bName,
  aColor,
  bColor,
}: {
  days: HeadToHeadDay[];
  aName: string;
  bName: string;
  aColor: string;
  bColor: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [span, setSpan] = useState<30 | 90>(90);

  const shown = useMemo(() => days.slice(-span), [days, span]);
  const max = useMemo(
    () => Math.max(1, ...shown.flatMap((d) => [d.a ?? 0, d.b ?? 0])),
    [shown],
  );
  const niceTop = niceMax(max);

  const W = 1100;
  const H = 300;
  const PAD_L = 56;
  const PAD_R = 12;
  const PAD_T = 16;
  const RIBBON = 14;
  const PAD_B = 34 + RIBBON;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const n = shown.length;
  const slot = plotW / n;
  const barW = Math.max(1.5, (slot - 2) / 2);
  const y = (v: number) => PAD_T + plotH - (v / niceTop) * plotH;

  const hovered = hover !== null ? shown[hover] : null;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * niceTop);

  return (
    <div className="w-full">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-4 text-[11px] text-ink-soft">
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: aColor }} />
            {aName}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: bColor }} />
            {bName}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {hovered ? (
            <p
              className="text-[11px] tabular-nums text-ink-soft"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              {fmtDate(hovered.day)} · {aName} {fmtUsd(hovered.a)} · {bName} {fmtUsd(hovered.b)}
              {hovered.a !== null && hovered.b !== null && hovered.b > 0
                ? ` · ${((hovered.a / hovered.b) * 100).toFixed(0)}%`
                : ""}
            </p>
          ) : (
            <p className="text-[11px] text-ink-faint">UTC days, one side per trade</p>
          )}
          <div className="inline-flex overflow-hidden rounded border border-rule text-[11px]">
            {([30, 90] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpan(s)}
                className={`px-2 py-0.5 ${span === s ? "bg-accent text-white" : "text-ink-soft hover:text-ink"}`}
              >
                {s}d
              </button>
            ))}
          </div>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Daily perp volume, ${aName} vs ${bName}, last ${span} UTC days`}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y(t)}
              y2={y(t)}
              stroke="currentColor"
              strokeOpacity={t === 0 ? 0.35 : 0.08}
            />
            <text
              x={PAD_L - 6}
              y={y(t) + 3}
              textAnchor="end"
              fontSize={10}
              fill="currentColor"
              fillOpacity={0.55}
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              {fmtAxis(t)}
            </text>
          </g>
        ))}
        {shown.map((d, i) => {
          const x0 = PAD_L + i * slot + 1;
          const active = hover === i;
          return (
            <g key={d.day}>
              {d.a !== null && (
                <rect
                  x={x0}
                  y={y(d.a)}
                  width={barW}
                  height={Math.max(0.5, PAD_T + plotH - y(d.a))}
                  fill={aColor}
                  fillOpacity={active ? 1 : 0.8}
                />
              )}
              {d.b !== null && (
                <rect
                  x={x0 + barW}
                  y={y(d.b)}
                  width={barW}
                  height={Math.max(0.5, PAD_T + plotH - y(d.b))}
                  fill={bColor}
                  fillOpacity={active ? 1 : 0.8}
                />
              )}
              <rect
                x={PAD_L + i * slot}
                y={H - PAD_B + 8}
                width={slot - 1}
                height={RIBBON - 4}
                rx={1}
                fill={d.lead === "a" ? aColor : d.lead === "b" ? bColor : "currentColor"}
                fillOpacity={d.lead ? 0.85 : 0.08}
              />
              <rect
                x={PAD_L + i * slot}
                y={PAD_T}
                width={slot}
                height={H - PAD_T}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            </g>
          );
        })}
        {hovered && hover !== null && (
          <line
            x1={PAD_L + hover * slot + slot / 2}
            x2={PAD_L + hover * slot + slot / 2}
            y1={PAD_T}
            y2={PAD_T + plotH}
            stroke="currentColor"
            strokeOpacity={0.3}
            strokeDasharray="2 3"
          />
        )}
        <text
          x={PAD_L}
          y={H - 4}
          fontSize={10}
          fill="currentColor"
          fillOpacity={0.55}
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {fmtDate(shown[0]?.day ?? "")}
        </text>
        <text
          x={W - PAD_R}
          y={H - 4}
          textAnchor="end"
          fontSize={10}
          fill="currentColor"
          fillOpacity={0.55}
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {fmtDate(shown.at(-1)?.day ?? "")}
        </text>
        <text
          x={PAD_L - 6}
          y={H - PAD_B + 8 + RIBBON / 2}
          textAnchor="end"
          fontSize={9}
          fill="currentColor"
          fillOpacity={0.55}
        >
          lead
        </text>
      </svg>
    </div>
  );
}

function niceMax(v: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / exp;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return step * exp;
}

function fmtAxis(v: number): string {
  if (v === 0) return "0";
  if (v >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${+(v / 1e6).toFixed(0)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(0)}K`;
  return v.toFixed(0);
}

function fmtUsd(v: number | null): string {
  if (v === null) return "n/a";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}
