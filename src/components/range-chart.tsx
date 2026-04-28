import type { ProviderResult } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";

type Props = {
  results: ProviderResult[];
  unit: string;
};

/**
 * Editorial range plot — neutral typography, every provider rendered with
 * equal visual weight. No "leader" emphasis; readers do their own ranking.
 */
export function RangeChart({ results, unit }: Props) {
  if (!results.length) return null;
  const max = Math.max(...results.map((r) => r.ms.p99));
  const sorted = [...results].sort((a, b) => a.ms.p50 - b.ms.p50);
  const ticks = buildTicks(max);
  const median = sorted[Math.floor(sorted.length / 2)].ms.p50;

  return (
    <div className="border-y-2 border-ink py-7">
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
        <span
          className="pointer-events-none absolute top-5 -translate-x-1/2 whitespace-nowrap font-sans text-[9px] uppercase tracking-[0.16em] text-ink-muted bg-paper px-1"
          style={{ left: `${(median / max) * 100}%` }}
        >
          ↓ Field median
        </span>
      </div>

      <ul className="mt-9 space-y-3">
        {sorted.map((r, i) => {
          const left = (r.ms.p50 / max) * 100;
          const mid = (r.ms.p90 / max) * 100;
          const right = (r.ms.p99 / max) * 100;
          return (
            <li
              key={r.slug}
              className="grid grid-cols-[7.5rem_1fr_5rem] sm:grid-cols-[10rem_1fr_5.5rem] items-center gap-3 sm:gap-4"
            >
              <div className="flex items-baseline gap-2 truncate">
                <span className="font-mono text-[10px] tabular text-ink-muted">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="truncate text-sm text-ink">{r.name}</span>
              </div>
              <div className="relative h-5">
                <span
                  className="absolute top-1/2 h-px bg-ink-soft"
                  style={{
                    left: `${left}%`,
                    width: `${right - left}%`,
                    transform: "translateY(-50%)",
                  }}
                />
                <Marker pct={left} kind="solid" />
                <Marker pct={mid} kind="outline" />
                <Marker pct={right} kind="tick" />
              </div>
              <span className="text-right font-mono text-sm tabular text-ink-soft">
                {fmtUnit(r.ms.p50, unit)}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="ml-32 sm:ml-44 mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 font-sans text-[10px] uppercase tracking-[0.16em] text-ink-muted">
        <Legend kind="solid" label="p50" />
        <Legend kind="outline" label="p90" />
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-px bg-ink-soft" /> p99
        </span>
      </div>
    </div>
  );
}

function Marker({
  pct,
  kind,
}: {
  pct: number;
  kind: "solid" | "outline" | "tick";
}) {
  const color = "var(--color-ink-soft)";
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
  if (unit === "pct") {
    if (v >= 1) return `${v.toFixed(0)}%`;
    if (v >= 0.1) return `${v.toFixed(1)}%`;
    return `${v.toFixed(2)}%`;
  }
  if (unit === "bps") {
    const pct = v / 100;
    if (pct >= 1) return `${pct.toFixed(0)}%`;
    return `${pct.toFixed(2)}%`;
  }
  if (unit === "s") {
    const s = v / 1000;
    if (s >= 60) return `${(s / 60).toFixed(0)}m`;
    return `${s.toFixed(s >= 10 ? 0 : 1)}s`;
  }
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  return `${v}ms`;
}
