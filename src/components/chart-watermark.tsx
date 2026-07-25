/**
 * Subtle openchainbench.com attribution that renders in both the on-screen
 * chart and inside any PNG capture (see `chart-export-button.tsx`). Kept
 * low-opacity so it never competes with the data; the copy is small enough
 * to survive Twitter/Slack recompression without pixel loss on the value.
 *
 * Two variants:
 *   - `<ChartWatermarkSvg>`  → inlined <text> element for SVG charts
 *     (time-series). Positioned bottom-right of the plot area.
 *   - `<ChartWatermarkHtml>` → absolutely-positioned HTML span for
 *     HTML-composed charts (ranked bar). Parent must be `relative`.
 *
 * Colour picks `--color-ink-faint` so it inherits the dark/light theme
 * variables and stays legible on both without hardcoded hex.
 */

export function ChartWatermarkSvg({
  x,
  y,
  anchor = "end",
}: {
  x: number;
  y: number;
  anchor?: "start" | "middle" | "end";
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      className="pointer-events-none select-none"
      style={{
        fontFamily: "var(--font-jetbrains-mono, ui-monospace, monospace)",
        fontSize: "11px",
        letterSpacing: "0.08em",
        fill: "var(--color-ink)",
        fillOpacity: 0.28,
      }}
    >
      openchainbench.com
    </text>
  );
}

export function ChartWatermarkHtml({
  position = "bottom-right",
}: {
  position?: "bottom-right" | "bottom-left" | "top-right";
}) {
  const cls =
    position === "bottom-right"
      ? "bottom-1 right-2"
      : position === "bottom-left"
        ? "bottom-1 left-2"
        : "top-1 right-2";
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute ${cls} select-none font-sans font-medium uppercase text-[10px] tracking-[0.1em] text-ink`}
      style={{ opacity: 0.28 }}
    >
      openchainbench.com
    </span>
  );
}
