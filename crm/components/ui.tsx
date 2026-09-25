export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return Math.round(n).toLocaleString("en-US");
}
export function fmtPct(x: number | null | undefined, digits = 0): string {
  if (x == null || !Number.isFinite(x)) return "–";
  return `${(x * 100).toFixed(digits)}%`;
}

/** Week over week change, as a signed percentage. */
export function Delta({ now, prev }: { now: number; prev: number }) {
  if (prev <= 0 && now <= 0) return <span className="flat">–</span>;
  if (prev <= 0) return <span className="up">new</span>;
  const d = (now - prev) / prev;
  const cls = Math.abs(d) < 0.02 ? "flat" : d > 0 ? "up" : "down";
  return (
    <span className={cls}>
      {d > 0 ? "+" : ""}
      {(d * 100).toFixed(0)}%
    </span>
  );
}

export function Kpi({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: { now: number; prev: number } }) {
  return (
    <div className="panel px-4 py-3">
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
    </div>
  );
}

/** Inline SVG line chart; no client code. */
export function Spark({ series, height = 56, width = 320, color = "var(--accent)" }: { series: number[]; height?: number; width?: number; color?: string }) {
  if (series.length < 2) return <div style={{ height }} />;
  const max = Math.max(1, ...series);
  const pts = series.map((v, i) => `${((i / (series.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - (v / max) * (height - 6)).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Bars({ rows, max }: { rows: { label: string; value: number; hint?: string }[]; max?: number }) {
  const m = Math.max(1, max ?? Math.max(...rows.map((r) => r.value)));
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,1fr)_3fr_auto] items-center gap-2 text-xs">
          <span className="truncate" title={r.label}>
            {r.label}
          </span>
          <span className="h-2 rounded-sm" style={{ background: "var(--line)" }}>
            <span className="block h-2 rounded-sm" style={{ width: `${(r.value / m) * 100}%`, background: "var(--accent)" }} />
          </span>
          <span className="mono" style={{ color: "var(--muted)" }}>
            {fmtInt(r.value)}
            {r.hint ? ` ${r.hint}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Inline multi-series SVG line chart with a legend; no client code. Each
 *  series is scaled to the shared maximum so the surfaces stay comparable;
 *  `logScale` compresses a series that dwarfs the others (HTML pageviews
 *  against a handful of agent reads a day). */
export function Lines({
  series,
  height = 120,
  width = 640,
  logScale = false,
}: {
  series: { name: string; color: string; values: number[] }[];
  height?: number;
  width?: number;
  logScale?: boolean;
}) {
  const n = Math.max(...series.map((s) => s.values.length), 0);
  if (n < 2) return <div style={{ height }} />;
  const y = (v: number) => (logScale ? Math.log10(v + 1) : v);
  const max = Math.max(1e-9, ...series.flatMap((s) => s.values.map(y)));
  const x = (i: number) => ((i / (n - 1)) * (width - 2) + 1).toFixed(1);
  const py = (v: number) => (height - 2 - (y(v) / max) * (height - 6)).toFixed(1);
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden>
        {series.map((s) => (
          <polyline
            key={s.name}
            points={s.values.map((v, i) => `${x(i)},${py(v)}`).join(" ")}
            fill="none"
            stroke={s.color}
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: "var(--muted)" }}>
        {series.map((s) => (
          <li key={s.name} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
            {s.name}
            <span className="mono">{fmtInt(s.values.reduce((a, v) => a + v, 0))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <p className="py-6 text-center text-xs" style={{ color: "var(--faint)" }}>
      {text}
    </p>
  );
}
