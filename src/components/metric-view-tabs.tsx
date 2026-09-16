"use client";

import { useId, useState } from "react";
import type { MetricPanel } from "@/types/benchmark";

/**
 * Tab row that lives directly above the time-series chart. One pill per
 * metric panel, plus a "Default" pill at the front that switches the chart
 * back to the bench's main spec-defined metric.
 *
 * Each pill carries the panel's spec `description` as a tooltip (hover and
 * keyboard focus), and the active view's description is repeated as a
 * caption under the row so the definition is readable on touch screens,
 * where there is no hover. The headline tab reads `panel_main_description`.
 *
 * Pure presentation: holds no state beyond which tooltip is open. The
 * parent (benchmark-body) owns the active panel id and passes it down with
 * the swap callback.
 */
export function MetricViewTabs({
  panels,
  mainLabel,
  mainDescription,
  activeId,
  onSelect,
  hideMain = false,
}: {
  panels: MetricPanel[];
  mainLabel: string;
  mainDescription?: string;
  activeId: string | null;
  onSelect: (id: string | null) => void;
  /** Drop the headline tab (spec chart.hide_headline_by_chain). */
  hideMain?: boolean;
}) {
  const active = activeId == null ? null : panels.find((p) => p.id === activeId);
  const activeDescription =
    activeId == null ? mainDescription : active?.description;

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-2 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          View
        </span>
        {!hideMain && (
          <Tab
            label={mainLabel}
            description={mainDescription}
            active={activeId == null}
            onClick={() => onSelect(null)}
          />
        )}
        {panels.map((p) => (
          <Tab
            key={p.id}
            label={p.label}
            description={p.description}
            active={activeId === p.id}
            onClick={() => onSelect(p.id)}
          />
        ))}
      </div>
      {activeDescription && (
        <p className="mt-1.5 text-[11px] leading-snug text-ink-muted">
          {activeDescription}
        </p>
      )}
    </div>
  );
}

function Tab({
  label,
  description,
  active,
  onClick,
}: {
  label: string;
  description?: string;
  active: boolean;
  onClick: () => void;
}) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const hasTip = !!description;

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        aria-describedby={hasTip && open ? tipId : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={[
          "rounded px-2.5 py-1 text-[11px] font-sans tabular uppercase tracking-[0.1em] font-medium transition-colors",
          active
            ? "bg-ink text-paper"
            : "text-ink-muted hover:text-ink hover:bg-paper-soft",
        ].join(" ")}
      >
        {label}
      </button>
      {hasTip && open && (
        <span
          id={tipId}
          role="tooltip"
          className="pointer-events-none absolute left-0 top-full z-50 mt-1 w-[min(22rem,80vw)] rounded-md border border-rule bg-paper px-3 py-2 shadow-xl"
        >
          <span className="block text-xs normal-case tracking-normal font-normal leading-snug text-ink-soft">
            <span className="font-medium text-ink">{label}:</span>{" "}
            {description}
          </span>
        </span>
      )}
    </span>
  );
}
