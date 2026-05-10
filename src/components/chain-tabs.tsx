"use client";

import { brandColor } from "@/lib/brand";

type ChainOption = { value: string; label: string };

/**
 * Chain filter tabs rendered above the chart on a bench detail page.
 * Stateless. parent owns the selected value and decides what to do on click
 * (typically: swap which pre-fetched benchmark variant is rendered, then
 * sync `?chain=` via `history.replaceState` to keep the URL shareable).
 *
 * Layout: a flat row of pill chips. Active chip fills with the chain's
 * brand color; inactive chips stay neutral. Designed to scale to ~12
 * options without the cramped table-tab look.
 */
export function ChainTabs({
  options,
  selected,
  onSelect,
}: {
  options: ChainOption[];
  selected: string | null;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => (
        <Tab
          key={o.value}
          onClick={() => onSelect(o.value)}
          active={selected === o.value}
          label={o.label}
          accent={brandColor(o.value)}
        />
      ))}
    </div>
  );
}

function Tab({
  active,
  label,
  onClick,
  accent,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  accent: string | null;
}) {
  if (active) {
    return (
      <button
        type="button"
        onClick={onClick}
        style={{
          background: accent ?? "var(--color-ink)",
          color: "var(--color-paper)",
        }}
        className="px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] rounded-md shadow-sm transition-colors"
      >
        {label}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] rounded-md border border-rule text-ink-muted hover:text-ink hover:bg-paper-soft transition-colors"
    >
      {label}
    </button>
  );
}
