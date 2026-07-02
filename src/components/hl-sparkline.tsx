/**
 * Compact log-scale sparkline shared by the /hyperliquid leaderboard row
 * and any future card surface. Mirrors the Y transform used by the parent
 * `HlHistoryChart` (`log10(v + 1)`) so a $200 frontend and a $5M frontend
 * both render readable shapes at the small sizes we need in a table row.
 *
 * Null values break the SVG path so gaps render as gaps rather than
 * dropping to zero — same semantic as the harness' missing-sample rule.
 */

type Props = {
  values: (number | null)[];
  /** Optional pixel width. Default 200 fits the leaderboard column. */
  width?: number;
  /** Optional pixel height. Default 24 keeps rows compact. */
  height?: number;
  /** Stroke colour. Default matches the primary sparkline accent. */
  stroke?: string;
  /** Rendered when the series has no non-null value. Defaults to em-dash. */
  emptyLabel?: string;
};

export function HlSparkline({
  values,
  width = 200,
  height = 24,
  stroke = "#9d65ff",
  emptyLabel = "—",
}: Props) {
  const PAD = 1.5;
  const plotW = width - PAD * 2;
  const plotH = height - PAD * 2;

  let vMax = 0;
  let hasAny = false;
  for (const v of values) {
    if (v !== null && Number.isFinite(v)) {
      hasAny = true;
      if (v > vMax) vMax = v;
    }
  }
  if (!hasAny) {
    return (
      <span
        className="inline-block text-[11px] text-ink-faint"
        style={{
          width,
          textAlign: "center",
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        {emptyLabel}
      </span>
    );
  }

  const logMax = Math.log10(vMax + 1);
  const logDen = logMax || 1;
  const n = values.length;
  const xFor = (i: number) =>
    PAD + (n === 1 ? 0 : (i / (n - 1)) * plotW);
  const yFor = (v: number) => {
    const clamped = v > 0 ? v : 0;
    const norm = Math.log10(clamped + 1) / logDen;
    return PAD + plotH * (1 - norm);
  };

  const parts: string[] = [];
  let inSeg = false;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) {
      inSeg = false;
      continue;
    }
    const cmd = inSeg ? "L" : "M";
    parts.push(`${cmd} ${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)}`);
    inSeg = true;
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="block"
    >
      <path
        d={parts.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ opacity: 0.9 }}
      />
    </svg>
  );
}
