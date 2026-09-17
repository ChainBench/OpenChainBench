/**
 * Linear min/max sparkline with a soft area fill and an end dot, for
 * table rows where every series lives in its own range (a $200K bot next
 * to a $300M app). The Y range is the series' own min..max with 12 %
 * headroom, so a 170M → 327M week reads as a real move instead of the
 * flat line a 0-based or log scale gives at 24 px tall.
 *
 * Nulls break the path (gaps stay gaps). Server-safe, no hooks.
 */
export function TrendSparkline({
  values,
  width = 140,
  height = 26,
  color = "#9d65ff",
  id,
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
  color?: string;
  /** Unique id for the gradient (one per row). */
  id: string;
}) {
  const PAD_X = 2;
  const PAD_Y = 3;
  const DOT = 2.2;
  const plotW = width - PAD_X * 2 - DOT;
  const plotH = height - PAD_Y * 2;

  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 2) {
    return (
      <span className="inline-block text-[11px] text-ink-faint" style={{ width, textAlign: "center" }}>
        —
      </span>
    );
  }
  let lo = Math.min(...nums);
  let hi = Math.max(...nums);
  if (hi === lo) {
    lo = lo * 0.9;
    hi = hi * 1.1 || 1;
  }
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;

  const n = values.length;
  const x = (i: number) => PAD_X + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD_Y + plotH - ((v - lo) / (hi - lo)) * plotH;

  // Line path with gaps, plus one closed area per contiguous run.
  let line = "";
  const areas: string[] = [];
  let run: string[] = [];
  let runStart = -1;
  let runEnd = -1;
  const flush = () => {
    if (run.length >= 2) {
      areas.push(
        `M${x(runStart).toFixed(1)},${(PAD_Y + plotH).toFixed(1)} L${run.join(" L")} L${x(runEnd).toFixed(1)},${(PAD_Y + plotH).toFixed(1)} Z`,
      );
    }
    run = [];
    runStart = -1;
  };
  let pen = false;
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      pen = false;
      flush();
      return;
    }
    const pt = `${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    line += `${pen ? "L" : "M"}${pt} `;
    if (!pen) runStart = i;
    runEnd = i;
    run.push(pt);
    pen = true;
  });
  flush();

  let lastIdx = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (values[i] != null) {
      lastIdx = i;
      break;
    }
  }
  const gid = `spk-${id}`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="block">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      {areas.map((d, i) => (
        <path key={i} d={d} fill={`url(#${gid})`} />
      ))}
      <path d={line} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
      {lastIdx >= 0 && <circle cx={x(lastIdx)} cy={y(values[lastIdx] as number)} r={DOT} fill={color} />}
    </svg>
  );
}
