/**
 * Centered branded watermark: two horizontal rules flanking the OCB "C"
 * mark, with the openchainbench.com wordmark below. Discreet enough to
 * disappear during normal chart reading, visible enough to attribute
 * the graphic when it gets screenshot-shared. Baked inside the chart
 * frame so it survives any crop.
 *
 * Two variants:
 *   - `<ChartWatermarkSvg>`  → self-contained SVG group (time-series).
 *     Rendered inside the plot area BEFORE the data paths so the lines
 *     stack on top and the watermark reads as a background stamp.
 *   - `<ChartWatermarkHtml>` → absolutely-positioned centered block for
 *     HTML-composed charts (ranked bar). Parent must be `relative`.
 *
 * The C-mark geometry mirrors the masthead <SiteLogo> (site-logo.tsx)
 * so the brand reads identically across screen, favicon and screenshot.
 */

export function ChartWatermarkSvg({
  cx,
  cy,
  scale = 1,
}: {
  /** Center X of the plot area (padL + innerW/2). */
  cx: number;
  /** Center Y of the plot area (padT + innerH/2). */
  cy: number;
  /** Overall scale multiplier. Default 1 = ~140px wide composition. */
  scale?: number;
}) {
  const opacity = 0.18;
  const barW = 40 * scale;
  const gap = 32 * scale;
  const stroke = 0.9 * scale;
  const logoR = 8 * scale;
  const textY = 20 * scale;
  const fontSize = 8 * scale;
  return (
    <g
      transform={`translate(${cx} ${cy})`}
      className="pointer-events-none select-none"
      style={{ opacity }}
    >
      {/* Left + right hairlines — the "two bars" flanking the mark. */}
      <line
        x1={-(gap / 2 + barW)}
        y1={0}
        x2={-(gap / 2)}
        y2={0}
        stroke="var(--color-ink)"
        strokeWidth={stroke}
        strokeLinecap="round"
      />
      <line
        x1={gap / 2}
        y1={0}
        x2={gap / 2 + barW}
        y2={0}
        stroke="var(--color-ink)"
        strokeWidth={stroke}
        strokeLinecap="round"
      />
      {/* Center C-mark — inline copy of <SiteLogo> geometry so the SVG
          stays self-contained and can serialise cleanly in html-to-image. */}
      <g transform={`translate(${-logoR} ${-logoR}) scale(${(logoR * 2) / 100})`}>
        <mask id="cwmark-mask-svg">
          <rect width="100" height="100" fill="white" />
          <ellipse cx="45" cy="50" rx="22" ry="40" fill="black" />
          <rect x="45" y="38" width="55" height="24" fill="black" />
        </mask>
        <circle cx="45" cy="50" r="45" fill="var(--color-ink)" mask="url(#cwmark-mask-svg)" />
        <path d="M 65 0 L 100 0 L 100 35 Z" fill="var(--color-ink)" opacity="0.5" />
        <path d="M 65 100 L 100 100 L 100 65 Z" fill="var(--color-ink)" opacity="0.5" />
      </g>
      {/* Wordmark. Kept short + wide-tracked for a "stamped" look. */}
      <text
        x={0}
        y={textY}
        textAnchor="middle"
        dominantBaseline="middle"
        style={{
          fontFamily: "var(--font-jetbrains-mono, ui-monospace, monospace)",
          fontSize: `${fontSize}px`,
          fontWeight: 500,
          letterSpacing: "0.24em",
          fill: "var(--color-ink)",
          textTransform: "uppercase",
        }}
      >
        openchainbench.com
      </text>
    </g>
  );
}

export function ChartWatermarkHtml() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 flex flex-col items-center justify-center select-none"
      style={{ opacity: 0.18 }}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="h-px w-10 bg-ink"
          style={{ opacity: 0.9 }}
        />
        <svg
          width={20}
          height={20}
          viewBox="0 0 100 100"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden
        >
          <mask id="cwmark-mask-html">
            <rect width="100" height="100" fill="white" />
            <ellipse cx="45" cy="50" rx="22" ry="40" fill="black" />
            <rect x="45" y="38" width="55" height="24" fill="black" />
          </mask>
          <circle cx="45" cy="50" r="45" fill="currentColor" mask="url(#cwmark-mask-html)" className="text-ink" />
          <path d="M 65 0 L 100 0 L 100 35 Z" fill="currentColor" className="text-ink" opacity="0.5" />
          <path d="M 65 100 L 100 100 L 100 65 Z" fill="currentColor" className="text-ink" opacity="0.5" />
        </svg>
        <span
          aria-hidden
          className="h-px w-10 bg-ink"
          style={{ opacity: 0.9 }}
        />
      </div>
      <span
        className="mt-1.5 font-mono font-medium uppercase text-[9px] tracking-[0.24em] text-ink"
      >
        openchainbench.com
      </span>
    </div>
  );
}
