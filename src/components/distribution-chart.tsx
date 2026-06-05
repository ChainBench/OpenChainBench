"use client";

import { type ReactNode, useMemo } from "react";
import type { Benchmark } from "@/types/benchmark";
import { liveResults } from "@/lib/provider-filters";
import { Hint } from "@/components/hint";
import { ProviderLogo } from "@/components/provider-logo";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";
import { useChartExclusion } from "@/hooks/use-chart-exclusion";
import { useAnimatedDomain } from "@/hooks/use-animated-domain";
import { useTopN } from "@/hooks/use-top-n";
import { TopNSelector } from "@/components/top-n-selector";

/**
 * Latency-spread view, "percentile whisker" design.
 *
 * One row per provider. Each row carries a single continuous shape
 * encoding the p50 → p90 → p99 progression on a shared log axis:
 *
 *   ┌─ 100ms ── 1s ── 10s ── 1min ── 10min ── 1h ─┐  (landmark ticks)
 *   ├─────────────────────────────────────────────┤
 *   │ TON      ●━━━━┃                              │ ← dot + thick + tail + wall
 *   │ Monero               ●━━━━━━━━━━━┃           │
 *   └─────────────────────────────────────────────┘
 *
 * Two design choices that fix the previous version's pain points:
 *
 * 1. **Landmark axis** — the X axis snaps to fixed power-of-10 decades
 *    in the bench's native unit (10ms, 100ms, 1s, 10s, 1min, …). The
 *    visible landmarks only change when the data crosses a decade,
 *    so toggling a row almost never moves the rest of the chart —
 *    no more "shifting world". When the range does change, the
 *    transition runs through `useAnimatedDomain` (450 ms ease-out,
 *    20 % significance threshold).
 *
 * 2. **Excluded rows dim in place** — the row keeps its slot and its
 *    rank number, the whisker collapses to opacity 0. No layout
 *    reflow, no marker positions to lose your eye on.
 *
 * The whisker itself replaces the previous 3-marker + band + median
 * guide combo with one continuous shape: a thin connector from the
 * axis floor to p50, a filled dot at p50, a thick bar from p50 → p90
 * (the "typical worst case" band), a thinner tail from p90 → p99
 * (the heavy-tail band), and a small vertical wall at p99. The
 * silhouette encodes the full spread story in one eye-jump.
 */
export function DistributionChart({
  benchmark,
  excluded: controlledExcluded,
  onToggleExclude,
  onResetExcluded,
  topNControl,
  disableTopN,
  headerActions,
}: {
  benchmark: Benchmark;
  excluded?: Set<string>;
  onToggleExclude?: (slug: string) => void;
  onResetExcluded?: () => void;
  /** Optional slot rendered in the chart's header row, right-aligned.
   *  BenchmarkBody passes the <ViewSwitcher> here so the control sits
   *  on the same baseline as the chart title instead of floating in
   *  the card corner or eating a footer row of its own. */
  headerActions?: ReactNode;
  topNControl?: { topN: number | null; setTopN: (n: number | null) => void };
  disableTopN?: boolean;
}) {
  const { results, unit, higherIsBetter } = benchmark;
  const { excluded, toggle, reset } = useChartExclusion(
    controlledExcluded,
    onToggleExclude,
    onResetExcluded,
  );
  // topNControl is destructured from the function signature below — accept it via Props.


  const colors = useMemo(() => buildProviderColors(results), [results]);

  const live = liveResults(results);

  // Sort once; sort order does NOT depend on the excluded set, so a
  // row stays in its slot when toggled and the rank #N is stable.
  const sortedAll = useMemo(
    () =>
      [...live].sort((a, b) =>
        higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
      ),
    [live, higherIsBetter],
  );
  // Top-N selector — shared shape with the other chart views so the
  // reader can focus on the top tail without losing the option to widen.
  const { topN, setTopN, topNOptions } = useTopN(sortedAll.length, { external: topNControl, disabled: disableTopN });
  const sorted = useMemo(
    () => (topN == null ? sortedAll : sortedAll.slice(0, topN)),
    [sortedAll, topN],
  );

  // The animated domain is driven by the *visible* set's min/max snapped
  // to log-decade landmarks. Toggling a provider only moves the axis
  // when the visible data crosses a decade boundary — most clicks leave
  // the axis fixed (no shifting world). Hooks must run unconditionally,
  // so the empty-data render below uses placeholders for the math but
  // returns early before drawing anything.
  const visible = sorted.filter((r) => !excluded.has(r.slug));
  const visibleP50Min = visible.length > 0
    ? Math.min(...visible.map((r) => r.ms.p50).filter((v) => v > 0))
    : 1;
  const visibleP99Max = visible.length > 0
    ? Math.max(...visible.map((r) => r.ms.p99), 1)
    : 1;
  const landmarks = useMemo(
    () => pickLandmarks(visibleP50Min, visibleP99Max, unit),
    [visibleP50Min, visibleP99Max, unit],
  );
  const { lo: animLo, hi: animHi } = useAnimatedDomain(
    Math.log10(landmarks.lo),
    Math.log10(landmarks.hi),
  );

  if (live.length === 0) {
    return <p className="text-[12px] text-ink-faint py-8 text-center">No data.</p>;
  }

  const range = Math.max(animHi - animLo, 1e-6);
  const x = (v: number) => {
    if (v <= 0) return 0;
    return Math.max(0, Math.min(100, ((Math.log10(v) - animLo) / range) * 100));
  };

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-3 mb-4 min-h-7">
        <div className="flex items-baseline gap-3">
          <p className="text-[11px] font-sans font-medium uppercase tracking-[0.18em] text-ink-faint">
            Latency spread
          </p>
          <span className="text-[10px] font-sans uppercase tracking-[0.14em] text-ink-faint">
            {live.length} {live.length === 1 ? "provider" : "providers"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {excluded.size > 0 && (
            <button
              type="button"
              onClick={reset}
              className="text-[10px] font-sans font-medium uppercase tracking-[0.16em] text-ink-muted hover:text-ink lnk"
            >
              Reset · {excluded.size} excluded
            </button>
          )}
          <TopNSelector value={topN} options={topNOptions} onChange={setTopN} />
          <WhiskerLegend />
          {headerActions}
        </div>
      </div>

      {/* Axis tick rail — landmarks above the rows so the reader can
          decode any whisker's position back to a real time unit without
          hovering. The rail is 1 row tall + a hairline so it reads as
          a coordinate header, not a data row. */}
      <div className="relative h-5 mb-1 ml-[3rem] sm:ml-[3.5rem]" aria-hidden>
        {landmarks.ticks.map((t) => (
          <span
            key={t.value}
            className="absolute bottom-0 -translate-x-1/2 text-[10px] font-sans tabular tabular-nums text-ink-faint whitespace-nowrap"
            style={{ left: `${x(t.value)}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>
      <div className="relative h-px mb-2 ml-[3rem] sm:ml-[3.5rem] bg-rule" aria-hidden>
        {landmarks.ticks.map((t) => (
          <span
            key={t.value}
            className="absolute -top-1 h-2 w-px bg-rule"
            style={{ left: `${x(t.value)}%` }}
          />
        ))}
      </div>

      <ul className="flex flex-col">
        {sorted.map((r, i) => {
          const isOff = excluded.has(r.slug);
          const color = colors.get(r.slug) ?? "var(--color-ink-soft)";
          const p50Pct = x(r.ms.p50);
          const p90Pct = x(r.ms.p90);
          const p99Pct = x(r.ms.p99);
          // Mean is rendered as a small open ring layered on top of the
          // bands so the reader sees where the distribution's "centre of
          // gravity" sits versus the median (p50). For a healthy / Gaussian
          // distribution mean ≈ p50; the further mean drifts toward p99,
          // the more the heavy tail is dragging the average up — useful
          // signal that the percentile story alone can hide. We only show
          // the marker when the data exposes a meaningful mean (not equal
          // to p50, finite, > 0).
          const hasMean =
            Number.isFinite(r.ms.mean) &&
            r.ms.mean > 0 &&
            Math.abs(r.ms.mean - r.ms.p50) > Math.max(r.ms.p50 * 0.01, 1e-9);
          const meanPct = hasMean ? x(r.ms.mean) : null;
          // Subtle gridline at every landmark — drawn per-row so it
          // sits between the connector and the whisker, never above
          // the data. Same x positions as the tick rail above.
          return (
            <li
              key={r.slug}
              role="button"
              tabIndex={0}
              aria-pressed={isOff}
              aria-label={`${r.name}: p50 ${fmtUnit(r.ms.p50, unit)}, p99 ${fmtUnit(r.ms.p99, unit)}. ${isOff ? "Click to include." : "Click to exclude."}`}
              onClick={() => toggle(r.slug)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(r.slug);
                }
              }}
              className={`grid grid-cols-[1.5rem_minmax(6rem,9rem)_1fr_3.5rem_3.5rem] sm:grid-cols-[2rem_minmax(7rem,10rem)_1fr_4rem_4rem] items-center gap-2 sm:gap-3 py-2.5 border-b border-rule/50 last:border-b-0 cursor-pointer transition-all duration-300 hover:bg-paper-soft/40 ${
                isOff ? "opacity-30" : ""
              }`}
              style={{ transitionProperty: "opacity, background-color" }}
            >
              {/* Stable rank #N — does NOT renumber on exclude. The
                  reader sees the same provider in the same slot the
                  whole time they're toggling. */}
              <span className="font-sans tabular text-[10.5px] text-ink-faint text-right tabular-nums">
                #{i + 1}
              </span>

              <span className="flex items-center gap-2 min-w-0 justify-end">
                <ProviderLogo slug={r.slug} name={r.name} size={18} />
                <span
                  className={`font-sans font-medium text-[12.5px] truncate ${
                    isOff ? "line-through decoration-1 text-ink-faint" : "text-ink"
                  }`}
                >
                  {r.name}
                </span>
              </span>

              {/* The whisker. */}
              <div className="relative h-5">
                {/* Faint vertical gridlines at every landmark.
                    Per-row (not a single backdrop) so the row's hover
                    background paints behind them cleanly. */}
                {landmarks.ticks.map((t) => (
                  <span
                    key={t.value}
                    className="absolute top-1 bottom-1 w-px bg-rule/40"
                    style={{ left: `${x(t.value)}%` }}
                    aria-hidden
                  />
                ))}
                <Hint
                  label={
                    hasMean
                      ? `p50 ${fmtUnit(r.ms.p50, unit)} · mean ${fmtUnit(r.ms.mean, unit)} · p90 ${fmtUnit(r.ms.p90, unit)} · p99 ${fmtUnit(r.ms.p99, unit)}`
                      : `p50 ${fmtUnit(r.ms.p50, unit)} · p90 ${fmtUnit(r.ms.p90, unit)} · p99 ${fmtUnit(r.ms.p99, unit)}`
                  }
                >
                  <div
                    className="absolute inset-0"
                    style={{
                      opacity: isOff ? 0 : 1,
                      transition: "opacity 0.3s ease-out",
                    }}
                  >
                    {/* Connector — faint line from axis floor to p50.
                        Helps the eye locate the whisker in negative
                        space when a row's p50 sits far to the right. */}
                    <span
                      className="absolute top-1/2 -translate-y-1/2 h-px"
                      style={{
                        left: 0,
                        width: `${p50Pct}%`,
                        background: color,
                        opacity: 0.2,
                      }}
                    />
                    {/* p50 → p90 — the "typical worst case" band, full opacity. */}
                    <span
                      className="absolute top-1/2 -translate-y-1/2 h-[3px] rounded-sm"
                      style={{
                        left: `${p50Pct}%`,
                        width: `${Math.max(0, p90Pct - p50Pct)}%`,
                        background: color,
                        opacity: 0.85,
                      }}
                    />
                    {/* p90 → p99 — the heavy-tail band, lower opacity so
                        the eye can separate "typical bad day" from
                        "real outlier territory". */}
                    <span
                      className="absolute top-1/2 -translate-y-1/2 h-[2px]"
                      style={{
                        left: `${p90Pct}%`,
                        width: `${Math.max(0, p99Pct - p90Pct)}%`,
                        background: color,
                        opacity: 0.45,
                      }}
                    />
                    {/* p50 — filled dot, the headline. Drawn AFTER the
                        bands so it sits on top when the spread collapses
                        to a single point. */}
                    <span
                      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full"
                      style={{ left: `${p50Pct}%`, background: color }}
                      aria-label={`p50 ${fmtUnit(r.ms.p50, unit)}`}
                    />
                    {/* p99 wall — small vertical tick marking the tail's
                        absolute edge. Sits on top of the tail band. */}
                    <span
                      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-px h-2.5"
                      style={{ left: `${p99Pct}%`, background: color }}
                      aria-label={`p99 ${fmtUnit(r.ms.p99, unit)}`}
                    />
                    {/* Mean — small outlined ring. Shows where the
                        average sits versus the median (p50 dot). When
                        the ring drifts right of the dot, the tail is
                        pulling the average up. */}
                    {meanPct != null && (
                      <span
                        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full"
                        style={{
                          left: `${meanPct}%`,
                          border: `1.2px solid ${color}`,
                          background: "var(--color-paper)",
                        }}
                        aria-label={`mean ${fmtUnit(r.ms.mean, unit)}`}
                      />
                    )}
                  </div>
                </Hint>
              </div>

              <span className="font-mono tabular text-[11.5px] text-ink-soft text-right tabular-nums">
                {fmtUnit(r.ms.p50, unit)}
              </span>
              <span className="font-mono tabular text-[11.5px] text-ink-faint text-right tabular-nums">
                {fmtUnit(r.ms.p99, unit)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function WhiskerLegend() {
  return (
    <div className="hidden sm:flex items-center gap-2.5 text-[10px] font-sans uppercase tracking-[0.14em] text-ink-faint">
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: "var(--color-ink-muted)" }}
          aria-hidden
        />
        p50
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{
            border: "1.2px solid var(--color-ink-muted)",
            background: "var(--color-paper)",
          }}
          aria-hidden
        />
        mean
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block w-3 h-[3px] rounded-sm"
          style={{ background: "var(--color-ink-muted)" }}
          aria-hidden
        />
        p50→p90
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block w-3 h-[2px]"
          style={{ background: "var(--color-ink-muted)", opacity: 0.5 }}
          aria-hidden
        />
        p90→p99
      </span>
    </div>
  );
}

/**
 * Snap the visible [min, max] range to power-of-10 decades and emit a
 * tick set in the bench's native unit. We use log decades (not semantic
 * landmarks like "1 minute") so the helper works across every unit OCB
 * uses (ms, s, slots, count, bps, pct, usd) without per-unit lookup
 * tables. The labels are formatted via `fmtUnit` which already knows
 * unit conventions ("100ms", "1.0s", "$10K", etc.).
 *
 * Decade endpoints are picked so the visible data sits *between* two
 * displayed landmarks — the floor is the largest decade ≤ minP50, the
 * ceiling is the smallest decade ≥ maxP99. This means a typical toggle
 * of a single provider leaves the landmarks unchanged (the decade
 * boundaries don't move just because one row went away).
 */
function pickLandmarks(
  minV: number,
  maxV: number,
  unit: string,
): { lo: number; hi: number; ticks: { value: number; label: string }[] } {
  const safeMin = Math.max(minV, 1e-6);
  const safeMax = Math.max(maxV, safeMin * 10);
  const minDecade = Math.floor(Math.log10(safeMin));
  const maxDecade = Math.ceil(Math.log10(safeMax));
  const lo = Math.pow(10, minDecade);
  const hi = Math.pow(10, maxDecade);
  const ticks: { value: number; label: string }[] = [];
  // Hard cap of 8 ticks so a 1ms → 1d range (8 decades) still fits
  // without crowding. Wider ranges step the sampling.
  const totalDecades = maxDecade - minDecade;
  const step = totalDecades <= 8 ? 1 : Math.ceil(totalDecades / 7);
  for (let d = minDecade; d <= maxDecade; d += step) {
    const value = Math.pow(10, d);
    ticks.push({ value, label: fmtUnit(value, unit) });
  }
  // Ensure the rightmost landmark sits exactly at hi when stepping
  // would skip it (preserves the "ceiling tick" anchor).
  const last = ticks[ticks.length - 1];
  if (last && last.value !== hi) ticks.push({ value: hi, label: fmtUnit(hi, unit) });
  return { lo, hi, ticks };
}
