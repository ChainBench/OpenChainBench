"use client";

import type { MetricPanel } from "@/types/benchmark";

/**
 * Tab row that lives directly above the time-series chart. One pill per
 * metric panel, plus a "Default" pill at the front that switches the chart
 * back to the bench's main spec-defined metric.
 *
 * Pure presentation: holds no state. The parent (benchmark-body) owns the
 * active panel id and passes it down with the swap callback.
 */
export function MetricViewTabs({
  panels,
  mainLabel,
  activeId,
  onSelect,
}: {
  panels: MetricPanel[];
  mainLabel: string;
  activeId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1">
      <span className="mr-2 label-mono-xs">
        View
      </span>
      <Tab label={mainLabel} active={activeId == null} onClick={() => onSelect(null)} />
      {panels.map((p) => (
        <Tab
          key={p.id}
          label={p.label}
          active={activeId === p.id}
          onClick={() => onSelect(p.id)}
          title={p.metric}
        />
      ))}
    </div>
  );
}

function Tab({
  label,
  active,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={[
        "rounded px-2.5 py-1 text-[11px] font-sans tabular uppercase tracking-[0.1em] font-medium transition-colors",
        active
          ? "bg-ink text-paper"
          : "text-ink-muted hover:text-ink hover:bg-paper-soft",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
