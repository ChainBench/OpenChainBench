type Props = {
  values: number[];
  width?: number;
  height?: number;
  emphasis?: boolean;
  /** If provided, scale Y to this maximum across rows (consistent across small multiples). */
  globalMax?: number;
  globalMin?: number;
};

export function Sparkline({
  values,
  width = 92,
  height = 22,
  emphasis = false,
  globalMax,
  globalMin,
}: Props) {
  if (!values.length) return null;
  const min = globalMin ?? Math.min(...values);
  const max = globalMax ?? Math.max(...values);
  const range = max - min || 1;

  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const last = values[values.length - 1];
  const lastX = width;
  const lastY = height - ((last - min) / range) * height;

  const stroke = emphasis ? "var(--color-ink)" : "var(--color-ink-soft)";

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
        stroke={stroke}
        strokeWidth={emphasis ? 1.4 : 1}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
      <circle cx={lastX} cy={lastY} r={emphasis ? 2.2 : 1.8} fill={stroke} />
    </svg>
  );
}
