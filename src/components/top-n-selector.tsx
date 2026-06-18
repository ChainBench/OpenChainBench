"use client";

/**
 * Shared button group for chart Top-N selection. Renders nothing when
 * the option set is empty so the caller can include it unconditionally.
 * The active button styling mirrors the range / region tabs across
 * the chart toolbars so the whole control row reads as one unit.
 */
export function TopNSelector({
  value,
  options,
  onChange,
  className = "",
}: {
  value: number | null;
  options: (number | null)[];
  onChange: (n: number | null) => void;
  className?: string;
}) {
  if (options.length === 0) return null;
  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <span className="mr-2 label-mono-xs">
        Show
      </span>
      {options.map((n) => {
        const active = value === n;
        const label = n == null ? "All" : `Top ${n}`;
        return (
          <button
            key={String(n)}
            type="button"
            onClick={() => onChange(n)}
            className={`rounded-md border px-2 py-1 text-[11px] font-sans font-medium uppercase tracking-[0.1em] transition-all ${
              active
                ? "border-ink bg-ink text-paper"
                : "border-ink/15 bg-paper text-ink hover:border-ink/40"
            }`}
            aria-pressed={active}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
