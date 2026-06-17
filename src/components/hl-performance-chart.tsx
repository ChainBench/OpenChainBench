"use client";

import { useEffect, useState } from "react";

/**
 * Performance chart for a single Hyperliquid frontend: 30 daily revenue
 * bars + a unique-users line overlay. Mirrors the HyperTracker
 * "Performance" panel that ships above the builder's trader leaderboard.
 * Pure SVG (no recharts/D3 dependency) — the shape is fixed and the data
 * set is small (60 numbers).
 *
 * Client component: the data fetch hits /api/builder/<slug>/daily-series
 * after hydration so the server-side product page render stays fast. The
 * chart hides silently if the upstream node isn't reachable yet —
 * graceful degradation, not a broken section.
 */

type Point = {
  date: string;
  day_unix: number;
  fees_usd: number;
  volume_usd: number;
  users: number;
};

type Payload = {
  builder: string;
  as_of: number;
  days: number;
  points: Point[];
};

const BAR_COLOR = "var(--color-accent, #7a2e1f)";
const LINE_COLOR = "#3b82f6";

export function HlPerformanceChart({ slug }: { slug: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/builder/${encodeURIComponent(slug)}/daily-series`, {
      cache: "no-store",
    })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`http ${r.status}`)),
      )
      .then((p: Payload) => {
        if (!cancelled) setData(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (error) {
    if (typeof console !== "undefined")
      console.warn(`HlPerformanceChart fetch failed for ${slug}:`, error);
    return null;
  }
  if (!data) {
    return (
      <div className="mt-6 card-soft rounded-lg p-4 border border-ink/10 h-[300px] animate-pulse" />
    );
  }
  if (data.points.length === 0) return null;

  return <ChartCanvas data={data} />;
}

function ChartCanvas({ data }: { data: Payload }) {
  const W = 1100;
  const H = 320;
  const PAD_L = 56;
  const PAD_R = 56;
  const PAD_T = 24;
  const PAD_B = 48;

  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const n = data.points.length;

  const maxFees = Math.max(...data.points.map((p) => p.fees_usd), 0);
  const maxUsers = Math.max(...data.points.map((p) => p.users), 0);

  const totalFees30d = data.points.reduce((a, p) => a + p.fees_usd, 0);
  const peakUsers = Math.max(...data.points.map((p) => p.users));

  const barW = Math.max(4, plotW / n - 4);
  const xFor = (i: number) => PAD_L + (plotW * i) / Math.max(n - 1, 1);
  const yBar = (v: number) =>
    PAD_T + plotH - (maxFees > 0 ? (v / maxFees) * plotH : 0);
  const yLine = (v: number) =>
    PAD_T + plotH - (maxUsers > 0 ? (v / maxUsers) * plotH : 0);

  const niceMaxFees = niceMax(maxFees);
  const niceMaxUsers = niceMax(maxUsers);
  const ticks = [0, 0.25, 0.5, 0.75, 1.0];

  const xLabelEvery = Math.max(1, Math.ceil(n / 6));

  const linePath = data.points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yLine(p.users).toFixed(1)}`,
    )
    .join(" ");

  return (
    <div className="mt-6 card-soft rounded-lg p-4 sm:p-6 border border-ink/10">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div>
          <p className="label-mono text-[10px] text-ink-faint">
            Performance · last 30d
          </p>
          <p className="text-sm text-ink-faint mt-0.5">
            Daily revenue + unique users
          </p>
        </div>
        <div className="flex items-center gap-4 text-[11px]">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block w-3 h-3 rounded-sm"
              style={{ background: BAR_COLOR }}
            />
            Revenue
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block w-3 h-0.5"
              style={{ background: LINE_COLOR }}
            />
            Users
          </span>
        </div>
      </div>

      <div className="w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-[300px] sm:h-[320px]"
          preserveAspectRatio="none"
        >
          {ticks.map((t) => {
            const y = PAD_T + plotH * (1 - t);
            const valFees = niceMaxFees * t;
            const valUsers = niceMaxUsers * t;
            return (
              <g key={t}>
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  className="text-ink/10"
                  strokeWidth={1}
                />
                <text
                  x={PAD_L - 6}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-ink-faint text-[10px]"
                >
                  {fmtUSDShort(valFees)}
                </text>
                <text
                  x={W - PAD_R + 6}
                  y={y + 3}
                  textAnchor="start"
                  className="fill-ink-faint text-[10px]"
                >
                  {fmtCountShort(valUsers)}
                </text>
              </g>
            );
          })}

          {data.points.map((p, i) => {
            const x = xFor(i) - barW / 2;
            const y = yBar(p.fees_usd);
            const h = PAD_T + plotH - y;
            return (
              <rect
                key={p.day_unix}
                x={x}
                y={y}
                width={barW}
                height={Math.max(1, h)}
                fill={BAR_COLOR}
                opacity={0.85}
              />
            );
          })}

          <path
            d={linePath}
            fill="none"
            stroke={LINE_COLOR}
            strokeWidth={2}
          />
          {data.points.map((p, i) => (
            <circle
              key={p.day_unix}
              cx={xFor(i)}
              cy={yLine(p.users)}
              r={2.5}
              fill={LINE_COLOR}
            />
          ))}

          {data.points.map((p, i) =>
            i % xLabelEvery === 0 || i === n - 1 ? (
              <text
                key={p.day_unix}
                x={xFor(i)}
                y={H - PAD_B + 14}
                textAnchor="middle"
                className="fill-ink-faint text-[10px]"
              >
                {fmtShortDate(p.date)}
              </text>
            ) : null,
          )}
        </svg>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-ink-faint flex-wrap gap-x-4">
        <span>
          Σ Revenue 30d:{" "}
          <span className="text-ink font-semibold">{fmtUSD(totalFees30d)}</span>
        </span>
        <span>
          Peak users in a day:{" "}
          <span className="text-ink font-semibold">
            {fmtCountShort(peakUsers)}
          </span>
        </span>
        <span>
          Data as of{" "}
          {new Date(data.as_of * 1000).toUTCString().slice(17, 25)} UTC
        </span>
      </div>
    </div>
  );
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  if (f <= 1) return exp;
  if (f <= 2) return 2 * exp;
  if (f <= 5) return 5 * exp;
  return 10 * exp;
}

function fmtUSDShort(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

function fmtCountShort(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

function fmtShortDate(d: string): string {
  const [, mm, dd] = d.split("-");
  return `${dd}/${mm}`;
}
