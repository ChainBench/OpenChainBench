import { fmtUnit } from "@/lib/format";
import type { DrawnLine } from "./series";

type LegendProps = {
  drawn: DrawnLine[];
  unit: string;
  onToggleExclude?: (slug: string) => void;
  onResetExcluded?: () => void;
};

export function Legend({ drawn, unit, onToggleExclude, onResetExcluded }: LegendProps) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-t border-rule pt-3">
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {drawn.map((d) => {
          const clickable = !!onToggleExclude;
          return (
            <li key={d.slug}>
              <button
                type="button"
                onClick={clickable ? () => onToggleExclude(d.slug) : undefined}
                disabled={!clickable}
                aria-pressed={d.excluded}
                className={`inline-flex items-center gap-2 text-[12px] transition-opacity duration-200 ${
                  clickable ? "cursor-pointer hover:opacity-80" : "cursor-default"
                } ${d.excluded ? "opacity-40" : ""}`}
              >
                <span
                  className="inline-block h-px w-5"
                  style={{ background: d.color }}
                />
                <span
                  className={`font-medium ${
                    d.excluded ? "text-ink-faint line-through decoration-1" : "text-ink"
                  }`}
                >
                  {d.name}
                </span>
                <span className="font-sans tabular text-ink-muted text-[11px]">
                  {fmtUnit(d.last, unit)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {onResetExcluded && (
        <button
          type="button"
          onClick={onResetExcluded}
          className="text-[10px] font-sans font-medium uppercase tracking-[0.16em] text-ink-muted hover:text-ink lnk"
        >
          Reset
        </button>
      )}
    </div>
  );
}
