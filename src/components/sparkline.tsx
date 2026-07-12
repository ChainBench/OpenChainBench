type Props = {
  /** Dense series; `null` marks an empty Prom bucket. Nulls are skipped
   *  (the polyline connects across them). At 92x22 px a broken segment
   *  reads as noise, so compressing over gaps is the honest-enough
   *  cheap option for the trend column. */
  values: (number | null)[];
  width?: number;
  height?: number;
  color?: string;
  globalMax?: number;
  globalMin?: number;
};

export function Sparkline({
  values,
  width = 92,
  height = 22,
  color = "var(--color-ink-soft)",
  globalMax,
  globalMin,
}: Props) {
  const present = values.filter(
    (v): v is number => v != null && Number.isFinite(v),
  );
  if (!present.length) return null;
  const min = globalMin ?? Math.min(...present);
  const max = globalMax ?? Math.max(...present);
  const range = max - min || 1;

  const points = present
    .map((v, i) => {
      const x = (i / Math.max(1, present.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const last = present[present.length - 1];
  const lastY = height - ((last - min) / range) * height;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden
    >
      <polyline
        fill="none"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
      <circle cx={width} cy={lastY} r={1.8} fill={color} />
    </svg>
  );
}
