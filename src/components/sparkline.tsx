type Props = {
  values: number[];
  width?: number;
  height?: number;
  globalMax?: number;
  globalMin?: number;
};

export function Sparkline({
  values,
  width = 92,
  height = 22,
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
        stroke="var(--color-ink-soft)"
        strokeWidth={1.1}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
      <circle cx={width} cy={lastY} r={1.8} fill="var(--color-ink-soft)" />
    </svg>
  );
}
