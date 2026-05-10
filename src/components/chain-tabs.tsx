"use client";

import { brandColor } from "@/lib/brand";

type ChainOption = { value: string; label: string };

/**
 * Chain filter tabs rendered above the chart on a bench detail page.
 * Stateless. parent owns the selected value and decides what to do on click
 * (typically: swap which pre-fetched benchmark variant is rendered, then
 * sync `?chain=` via `history.replaceState` to keep the URL shareable).
 *
 * Active tab borrows the chain's brand color as a left rail accent.
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
    <div className="flex flex-wrap items-center gap-1 border border-rule rounded p-1 bg-paper-soft w-fit">
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
  const activeStyle =
    active && accent
      ? { boxShadow: `inset 3px 0 0 0 ${accent}` }
      : undefined;
  return (
    <button
      onClick={onClick}
      style={activeStyle}
      className={`px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] rounded transition-colors ${
        active
          ? "bg-paper text-ink shadow-sm"
          : "text-ink-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}
