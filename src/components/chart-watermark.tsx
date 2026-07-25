/**
 * DefiLlama-style diagonal attribution that lives BEHIND the chart data.
 * Large, rotated, very low opacity — reads as "openchainbench.com"
 * without competing with the lines/bars, and can't be crop-shaved because
 * it sits at the middle of the frame. Captured in every PNG export
 * (see `chart-export-button.tsx`).
 *
 * Two variants:
 *   - `<ChartWatermarkSvg>`  → inlined <text> at plot center (rotated
 *     -22°) for SVG charts (time-series). Must be rendered BEFORE the
 *     data paths so it sits behind the lines.
 *   - `<ChartWatermarkHtml>` → absolutely-positioned centered span for
 *     HTML-composed charts (ranked bar). Parent must be `relative` and
 *     the watermark must be rendered first (z-index 0) so bars stack on top.
 *
 * Opacity is intentionally lower than the bottom-right badge it replaced
 * (0.10 vs 0.28) because the diagonal glyph is much larger and would
 * otherwise dominate visually. Trade-off: still perfectly readable in a
 * screenshot recompressed by Twitter/Slack; disappears entirely under
 * fine-grained chart lines during normal reading.
 */

export function ChartWatermarkSvg({
  cx,
  cy,
  fontSize = 34,
}: {
  /** Center X of the plot area (padL + innerW/2). */
  cx: number;
  /** Center Y of the plot area (padT + innerH/2). */
  cy: number;
  /** Font size in SVG user units — scale up to fill larger charts. */
  fontSize?: number;
}) {
  return (
    <text
      x={cx}
      y={cy}
      textAnchor="middle"
      dominantBaseline="middle"
      transform={`rotate(-22 ${cx} ${cy})`}
      className="pointer-events-none select-none"
      style={{
        fontFamily: "var(--font-jetbrains-mono, ui-monospace, monospace)",
        fontSize: `${fontSize}px`,
        fontWeight: 500,
        letterSpacing: "0.06em",
        fill: "var(--color-ink)",
        fillOpacity: 0.04,
      }}
    >
      openchainbench.com
    </text>
  );
}

export function ChartWatermarkHtml() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center select-none font-mono font-medium uppercase text-[clamp(1rem,3vw,1.9rem)] tracking-[0.08em] text-ink"
      style={{ opacity: 0.045, transform: "rotate(-22deg)" }}
    >
      openchainbench.com
    </span>
  );
}
