import type { ProviderResult } from "@/data/benchmarks";
import { cn } from "@/lib/utils";
import { fmtUnit } from "@/lib/format";

type Props = {
  results: ProviderResult[];
  unit: string;
};

/**
 * Editorial range plot. Each provider gets a horizontal track:
 *   p50 dot ─── p90 dot ─── p99 tick
 * Axis ticks above, with a dashed median annotation.
 */
export function RangeChart({ results, unit }: Props) {
  const max = Math.max(...results.map((r) => r.ms.p99));
  const sorted = [...results].sort((a, b) => a.ms.p50 - b.ms.p50);
  const ticks = buildTicks(max);
  const median = sorted[Math.floor(sorted.length / 2)].ms.p50;

  return (
    <div className="border-y-2 border-ink py-7">
      {/* Top axis */}
      <div className="ml-32 sm:ml-44 relative">
        <div className="relative h-4">
          {ticks.map((t) => (
            <span
              key={t.value}
              className="absolute top-0 -translate-x-1/2 font-mono text-[10px] tabular text-ink-muted"
              style={{ left: `${(t.value / max) * 100}%` }}
            >
              {formatTick(t.value, unit)}
            </span>
          ))}
        </div>
        <div className="relative mt-1 h-px bg-ink/80">
          {ticks.map((t) => (
            <span
              key={t.value}
              className="absolute top-0 h-1.5 w-px bg-ink/80"
              style={{ left: `${(t.value / max) * 100}%` }}
            />
          ))}
        </div>
        {/* Median annotation */}
        <span
          className="pointer-events-none absolute top-5 -translate-x-1/2 whitespace-nowrap font-sans text-[9px] uppercase tracking-[0.16em] text-ink-muted bg-paper px-1"
          style={{ left: `${(median / max) * 100}%` }}
        >
          ↓ Field median
        </span>
      </div>

      {/* Median dashed gridline overlay (drawn full height) */}
      <ul className="relative mt-9 space-y-3">
        <span
          className="pointer-events-none absolute top-0 bottom-0 w-px"
          style={{
            left: `calc(${rowOffset()}px + ${(median / max) * (100 - 0)}%)`,
            backgroundImage:
              "linear-gradient(to bottom, var(--color-ink-faint) 50%, transparent 50%)",
            backgroundSize: "1px 6px",
          }}
        />
        {sorted.map((r, i) => {
          const isWinner = r.highlight === "winner";
          const left = (r.ms.p50 / max) * 100;
          const mid = (r.ms.p90 / max) * 100;
          const right = (r.ms.p99 / max) * 100;
          return (
            <li
              key={r.slug}
              className="grid grid-cols-[7.5rem_1fr_4.5rem] sm:grid-cols-[10rem_1fr_5rem] items-center gap-3 sm:gap-4"
            >
              <div className="flex items-baseline gap-2 truncate">
                <span className="font-mono text-[10px] tabular text-ink-muted">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span
                  className={cn(
                    "truncate text-sm",
                    isWinner ? "font-semibold text-ink" : "text-ink-soft"
                  )}
                >
                  {r.name}
                </span>
              </div>

              <div className="relative h-5">
                {/* range line */}
                <span
                  className={cn(
                    "absolute top-1/2 h-px",
                    isWinner ? "bg-ink" : "bg-ink-soft/70"
                  )}
                  style={{
                    left: `${left}%`,
                    width: `${right - left}%`,
                    transform: "translateY(-50%)",
                  }}
                />
                <Marker pct={left} kind="solid" winner={isWinner} />
                <Marker pct={mid} kind="outline" winner={isWinner} />
                <Marker pct={right} kind="tick" winner={isWinner} />
              </div>

              <span
                className={cn(
                  "text-right font-mono text-sm tabular",
                  isWinner ? "font-semibold text-ink" : "text-ink-soft"
                )}
              >
                {fmtUnit(r.ms.p50, unit)}
              </span>
            </li>
          );
        })}
      </ul>

      {/* Legend */}
      <div className="ml-32 sm:ml-44 mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 font-sans text-[10px] uppercase tracking-[0.16em] text-ink-muted">
        <Legend kind="solid" label="p50" />
        <Legend kind="outline" label="p90" />
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-px bg-ink-soft" /> p99
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-px"
            style={{
              backgroundImage:
                "linear-gradient(to bottom, var(--color-ink-faint) 50%, transparent 50%)",
              backgroundSize: "1px 4px",
            }}
          />{" "}
          Median
        </span>
      </div>
    </div>
  );
}

/** Approximate horizontal offset of the range track from the row's start. */
function rowOffset() {
  // matches the grid template above (label column width). Best-effort, used
  // for the dashed median overlay that spans all rows.
  return 0;
}

function Marker({
  pct,
  kind,
  winner,
}: {
  pct: number;
  kind: "solid" | "outline" | "tick";
  winner: boolean;
}) {
  const color = winner ? "var(--color-ink)" : "var(--color-ink-soft)";
  if (kind === "tick") {
    return (
      <span
        className="absolute top-1/2 h-3 w-px"
        style={{
          left: `${pct}%`,
          transform: "translate(-50%, -50%)",
          background: color,
        }}
      />
    );
  }
  return (
    <span
      className="absolute top-1/2 h-2.5 w-2.5 rounded-full"
      style={{
        left: `${pct}%`,
        transform: "translate(-50%, -50%)",
        background: kind === "solid" ? color : "var(--color-paper)",
        border: `1.5px solid ${color}`,
      }}
    />
  );
}

function Legend({ kind, label }: { kind: "solid" | "outline"; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{
          background: kind === "solid" ? "var(--color-ink-soft)" : "var(--color-paper)",
          border: "1.5px solid var(--color-ink-soft)",
        }}
      />
      {label}
    </span>
  );
}

function buildTicks(max: number) {
  const ticks: { value: number }[] = [];
  const step = niceStep(max);
  for (let v = 0; v <= max; v += step) ticks.push({ value: v });
  return ticks;
}

function niceStep(max: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const norm = max / exp;
  let step: number;
  if (norm < 1.5) step = 0.2;
  else if (norm < 3) step = 0.5;
  else if (norm < 7) step = 1;
  else step = 2;
  return step * exp;
}

function formatTick(v: number, unit: string) {
  if (v === 0) return "0";
  if (unit === "s") {
    const s = v / 1000;
    if (s >= 60) return `${(s / 60).toFixed(0)}m`;
    return `${s.toFixed(s >= 10 ? 0 : 1)}s`;
  }
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  return `${v}ms`;
}
