"use client";

import { brandColor } from "@/lib/brand";
import { ProviderLogo } from "@/components/provider-logo";
import { hasLogo } from "@/lib/logo-manifest";

type ChainOption = { value: string; label: string };

export type ChainMeta = {
  providers: number;
  metric: string;
  leader?: { name: string; value: string };
};

/**
 * Chain filter tabs rendered above the chart on a bench detail page.
 * Stateless. parent owns the selected value and decides what to do on click
 * (typically: swap which pre-fetched benchmark variant is rendered, then
 * sync `?chain=` via `history.replaceState` to keep the URL shareable).
 *
 * Layout: a flat row of pill chips. Active chip fills with the chain's
 * brand color; inactive chips stay neutral. Hover any chip for a small
 * peek at how that chain is doing without leaving the current view.
 */
export function ChainTabs({
  options,
  selected,
  onSelect,
  meta,
}: {
  options: ChainOption[];
  selected: string | null;
  onSelect: (value: string) => void;
  meta?: Record<string, ChainMeta>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => (
        <Tab
          key={o.value}
          onClick={() => onSelect(o.value)}
          active={selected === o.value}
          value={o.value}
          label={o.label}
          accent={brandColor(o.value)}
          info={meta?.[o.value]}
        />
      ))}
    </div>
  );
}

function Tab({
  active,
  value,
  label,
  onClick,
  accent,
  info,
}: {
  active: boolean;
  value: string;
  label: string;
  onClick: () => void;
  accent: string | null;
  info: ChainMeta | undefined;
}) {
  const baseClass =
    "relative group px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] rounded-md transition-colors";
  const activeStyle = active
    ? {
        background: accent ?? "var(--color-ink)",
        color: "var(--color-paper)",
      }
    : undefined;
  const className = active
    ? `${baseClass} shadow-sm`
    : `${baseClass} border border-rule text-ink-muted hover:text-ink hover:bg-paper-soft`;

  return (
    <button type="button" onClick={onClick} style={activeStyle} className={className}>
      <span className="inline-flex items-center gap-1.5">
        {hasLogo(value) && (
          <ProviderLogo slug={value} name={label} size={14} />
        )}
        {label}
      </span>
      {info && (info.providers > 0 || info.leader) && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 hidden -translate-x-1/2 w-[min(16rem,90vw)] rounded-md border border-rule bg-paper p-2.5 shadow-xl group-hover:block text-left normal-case tracking-normal"
        >
          <p
            className="text-[10px] font-medium uppercase tracking-[0.16em]"
            style={{ color: accent ?? "var(--color-ink)" }}
          >
            {label}
          </p>
          {info.leader ? (
            <p className="mt-1.5 text-xs text-ink leading-snug">
              <span className="font-semibold">{info.leader.name}</span>
              <span className="text-ink-muted"> · {info.leader.value}</span>
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-ink-muted">No provider live yet.</p>
          )}
          <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            {info.providers} provider{info.providers === 1 ? "" : "s"} · {info.metric}
          </p>
        </span>
      )}
    </button>
  );
}
