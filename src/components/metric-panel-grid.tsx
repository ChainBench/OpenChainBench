"use client";

import { useState } from "react";
import type { Benchmark, MetricPanel } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";

/**
 * Switchable mini leaderboard surfaced under the main ledger.
 *
 * Each panel declares one Prom metric (already fetched server side and
 * stored in `benchmark.metricPanels`). The reader toggles between panels;
 * the visible table re-ranks the same provider set by the active panel's
 * metric, applying its higher_is_better direction.
 *
 * Renders nothing when `benchmark.metricPanels` is empty, so non-HL
 * benches that do not declare any panels stay unaffected.
 */
export function MetricPanelGrid({ benchmark }: { benchmark: Benchmark }) {
  const panels = benchmark.metricPanels ?? [];
  const [activeId, setActiveId] = useState<string | null>(panels[0]?.id ?? null);

  if (panels.length === 0) return null;

  const active = panels.find((p) => p.id === activeId) ?? panels[0];

  return (
    <section className="mt-8">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="label-mono text-ink-faint">Companion metrics</h2>
          {active.description && (
            <p className="mt-1 text-[12px] text-ink-muted max-w-xl">
              {active.description}
            </p>
          )}
        </div>
        <PanelTabs panels={panels} active={active.id} onSelect={setActiveId} />
      </header>

      <MetricPanelTable panel={active} benchmark={benchmark} />
    </section>
  );
}

function PanelTabs({
  panels,
  active,
  onSelect,
}: {
  panels: MetricPanel[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {panels.map((p) => {
        const on = p.id === active;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            className={[
              "rounded px-2.5 py-1 text-[11px] font-sans tabular uppercase tracking-[0.1em] font-medium transition-colors",
              on
                ? "bg-ink text-paper"
                : "text-ink-muted hover:text-ink hover:bg-paper-soft",
            ].join(" ")}
            title={p.metric}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

function MetricPanelTable({
  panel,
  benchmark,
}: {
  panel: MetricPanel;
  benchmark: Benchmark;
}) {
  // Build rows from the live provider set so unknown/extra slugs in
  // panel.values get ignored (defensive against a stale label rotation).
  const rows = benchmark.results
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      value: panel.values[r.slug],
    }))
    .filter((r) => Number.isFinite(r.value));

  rows.sort((a, b) =>
    panel.higherIsBetter ? b.value - a.value : a.value - b.value
  );

  const noData = benchmark.results.filter(
    (r) => !Number.isFinite(panel.values[r.slug])
  );

  if (rows.length === 0) {
    return (
      <p className="text-[12px] text-ink-faint italic">
        Currently no data for this metric. Will populate within ~1 hour once
        the harness fills its rolling window.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
      <table className="ledger w-full min-w-full border-collapse">
        <thead>
          <tr>
            <th className="border-y-2 border-ink py-2 pr-3 text-left text-[11px] uppercase tracking-[0.18em]">
              Provider
            </th>
            <th className="border-y-2 border-ink py-2 pl-3 text-right text-[11px] uppercase tracking-[0.18em]">
              {panel.label}
            </th>
            <th
              className="border-y-2 border-ink py-2 pl-3 text-right text-[11px] uppercase tracking-[0.18em] hidden md:table-cell"
              title="Position vs the others on this metric. Direction depends on the metric (lower better for fees / outages, higher better for activity)."
            >
              Rank
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.slug} className="border-b border-ink/10">
              <td className="py-2 pr-3 text-[13px] font-medium">{row.name}</td>
              <td className="py-2 pl-3 text-right text-[13px] tabular">
                {formatPanelValue(row.value, panel.unit)}
              </td>
              <td className="py-2 pl-3 text-right text-[12px] tabular text-ink-muted hidden md:table-cell">
                #{i + 1}
              </td>
            </tr>
          ))}
          {noData.map((p) => (
            <tr key={p.slug} className="border-b border-ink/10 text-ink-faint">
              <td className="py-2 pr-3 text-[13px]">{p.name}</td>
              <td className="py-2 pl-3 text-right text-[12px] italic">no data</td>
              <td className="py-2 pl-3 text-right text-[12px] hidden md:table-cell">
                {"—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatPanelValue(
  value: number,
  unit: MetricPanel["unit"]
): string {
  if (unit === "pct") {
    // Detect both 0..1 fractions and already-scaled percentages.
    const v = value > 1 ? value : value * 100;
    return `${v.toFixed(1)}%`;
  }
  if (unit === "count") {
    if (value >= 1000) return value.toFixed(0);
    if (value >= 10) return value.toFixed(1);
    return value.toFixed(2);
  }
  if (unit === "s") {
    if (value >= 3600) return `${(value / 3600).toFixed(1)}h`;
    if (value >= 60) return `${(value / 60).toFixed(1)}min`;
    return `${value.toFixed(0)}s`;
  }
  return fmtUnit(value, unit);
}
