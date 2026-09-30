"use client";

import { useEffect, useRef, useState } from "react";
import { Delta, fmtInt } from "@/components/ui";

export type SeriesPoint = { day: string; value: number };

/**
 * A headline number with its own history behind it.
 *
 * The dashboard used to show a 7-day total and a week-over-week delta,
 * with one shared visitors chart for everything. A number moving told
 * you it had moved, not when: a spike on one day and a steady climb over
 * seven read identically. Every card now carries its own sparkline, and
 * opening it gives the day-by-day series that produced the number.
 *
 * The chart is plain SVG and the dialog is the platform's own, so this
 * costs one small client component and no charting library. `<dialog>`
 * brings the focus trap, the Escape handler and the backdrop with it.
 */
export function Metric({
  label,
  value,
  series,
  delta,
  sub,
  unit,
}: {
  label: string;
  value: string;
  series: SeriesPoint[];
  delta?: { now: number; prev: number };
  sub?: string;
  unit?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const values = series.map((p) => p.value);
  const has = values.length >= 2 && values.some((v) => v > 0);

  return (
    <>
      <button
        type="button"
        onClick={() => has && setOpen(true)}
        aria-label={has ? `${label}: open the daily history` : label}
        className="panel px-4 py-3 text-left w-full"
        style={{ cursor: has ? "pointer" : "default" }}
      >
        <p className="label">{label}</p>
        <p className="mono mt-1 text-2xl font-semibold">{value}</p>
        <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
          {delta && (
            <>
              <Delta now={delta.now} prev={delta.prev} /> vs previous 7 d{sub ? " · " : ""}
            </>
          )}
          {sub}
        </p>
        <div className="mt-2" style={{ opacity: has ? 1 : 0.25 }}>
          <MiniChart series={values} height={30} />
        </div>
      </button>

      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // Click on the backdrop, which is the dialog element itself.
          if (e.target === ref.current) setOpen(false);
        }}
        className="panel"
        style={{ padding: 0, border: "1px solid var(--line)", maxWidth: "min(720px, 92vw)", width: "100%" }}
      >
        <div className="px-5 py-4">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <p className="label">{label}</p>
              <p className="mono mt-1 text-2xl font-semibold">{value}</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="text-xs" style={{ color: "var(--muted)" }}>
              Close
            </button>
          </div>

          {open && <DayChart series={series} unit={unit} />}

          <p className="mt-3 text-xs" style={{ color: "var(--faint)" }}>
            One point per UTC day. A visitor is a device cookie, so a person on
            a phone and a laptop counts twice and the same device counts once
            however many times it came back that day.
          </p>
        </div>
      </dialog>
    </>
  );
}

/** The card's sparkline: shape only, no axis. */
function MiniChart({ series, height }: { series: number[]; height: number }) {
  if (series.length < 2) return <div style={{ height }} />;
  const max = Math.max(1, ...series);
  const w = 320;
  const x = (i: number) => (i / (series.length - 1)) * (w - 2) + 1;
  const y = (v: number) => height - 2 - (v / max) * (height - 6);
  const line = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `1,${height} ${line} ${x(series.length - 1).toFixed(1)},${height}`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden>
      <polygon points={area} fill="var(--accent)" opacity="0.12" />
      <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * The full series, with the axis labels the sparkline omits and one bar
 * per day so a single spike is legible as a spike rather than a kink in
 * a line. Hovering a bar names its day and value.
 */
function DayChart({ series, unit }: { series: SeriesPoint[]; unit?: string }) {
  const max = Math.max(1, ...series.map((p) => p.value));
  const total = series.reduce((t, p) => t + p.value, 0);
  const peak = series.reduce((a, b) => (b.value > a.value ? b : a), series[0]);
  return (
    <div className="mt-4">
      <div className="flex items-end gap-[2px]" style={{ height: 160 }}>
        {series.map((p) => (
          <div
            key={p.day}
            title={`${p.day} · ${fmtInt(p.value)}${unit ? ` ${unit}` : ""}`}
            style={{
              flex: 1,
              height: `${Math.max(1, (p.value / max) * 100)}%`,
              background: "var(--accent)",
              opacity: p.value === 0 ? 0.15 : 0.75,
              borderRadius: "2px 2px 0 0",
              minWidth: 2,
            }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs" style={{ color: "var(--faint)" }}>
        <span className="mono">{series[0]?.day}</span>
        <span className="mono">{series.at(-1)?.day}</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
        <Stat label="Total" value={fmtInt(total)} />
        <Stat label="Peak day" value={`${fmtInt(peak?.value)} · ${peak?.day ?? "–"}`} />
        <Stat label="Daily average" value={fmtInt(total / Math.max(1, series.length))} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="label">{label}</p>
      <p className="mono mt-0.5">{value}</p>
    </div>
  );
}
