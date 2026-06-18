import { fmtUnit } from "@/lib/format";
import { formatHoursAgo } from "./scales";

type TooltipProps = {
  xPx: number;
  yPx: number;
  containerW: number;
  hoursAgo: number;
  windowHours: number;
  unit: string;
  rows: {
    slug: string;
    name: string;
    color: string;
    value: number;
  }[];
};

export function Tooltip({
  xPx,
  yPx,
  containerW,
  hoursAgo,
  windowHours,
  unit,
  rows,
}: TooltipProps) {
  // Flip the tooltip to the left of the cursor when near the right edge
  const flipLeft = xPx > containerW * 0.6;
  const offsetX = 14;
  const left = flipLeft ? undefined : xPx + offsetX;
  const right = flipLeft ? containerW - xPx + offsetX : undefined;

  // Anchor tooltip vertically to top of visible area but follow cursor a bit
  const top = Math.max(8, Math.min(yPx - 28, 320));

  return (
    <div
      className="pointer-events-none absolute z-10"
      style={{
        left,
        right,
        top,
      }}
    >
      <div
        className="rounded border border-rule bg-paper-soft/95 backdrop-blur-sm shadow-[0_12px_28px_-16px_rgba(28,26,23,0.25)] px-3 py-2.5 min-w-[12rem] sm:min-w-[14rem] max-w-[calc(100vw-2rem)] text-[11px]"
        style={{
          animation: "ts-tooltip-in 0.15s ease-out forwards",
        }}
      >
        <p className="font-sans tabular uppercase tracking-[0.12em] text-ink-muted font-medium">
          {formatHoursAgo(hoursAgo, windowHours)}
        </p>
        <ul className="mt-2 space-y-1">
          {rows.map((r) => (
            <li
              key={r.slug}
              className="grid grid-cols-[10px_1fr_auto] items-center gap-2"
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: r.color }}
              />
              <span className="text-ink truncate">{r.name}</span>
              <span className="font-sans tabular text-ink-soft">
                {fmtUnit(r.value, unit)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <style>{`
        @keyframes ts-tooltip-in {
          from { opacity: 0; transform: translateY(2px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
