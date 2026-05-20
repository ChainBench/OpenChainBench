/**
 * Radar / "cadran qui tourne" - animated SVG dial that sits on the right
 * of the home hero. Concentric circles + radial spokes + a sweeping orange
 * wedge that rotates around the centre. Pure CSS animation, no JS.
 *
 * Note: server-rendered SVG. The rotation is a CSS `@keyframes` declared
 * inline so the file is self-contained (no globals.css coupling).
 */
export function HeroRadar({ size = 520 }: { size?: number }) {
  const cx = 100;
  const cy = 100;
  const rings = [22, 38, 54, 70, 86];
  // 12 evenly-spaced spokes (every 30°)
  const spokes = Array.from({ length: 12 }, (_, i) => (i * Math.PI * 2) / 12);

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size, maxWidth: "100%" }}
      aria-hidden
    >
      <svg
        viewBox="0 0 200 200"
        className="w-full h-full"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <radialGradient id="hero-radar-sweep" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#EA580C" stopOpacity="0.18" />
            <stop offset="60%" stopColor="#EA580C" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#EA580C" stopOpacity="0" />
          </radialGradient>
          <mask id="hero-radar-mask">
            <rect width="200" height="200" fill="black" />
            <path d="M100 100 L100 5 A95 95 0 0 1 168 32 Z" fill="white" />
          </mask>
          <style>
            {`@keyframes hero-radar-rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
              .hero-radar-spin { transform-origin: 100px 100px; animation: hero-radar-rotate 9s linear infinite; }
              @keyframes hero-radar-pulse { 0%,100% { opacity: 0.55; } 50% { opacity: 1; } }
              .hero-radar-tip { animation: hero-radar-pulse 2.4s ease-in-out infinite; }`}
          </style>
        </defs>

        {/* Concentric rings */}
        {rings.map((r, i) => (
          <circle
            key={r}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="var(--color-rule-strong)"
            strokeWidth={0.5}
            strokeDasharray={i === 2 ? "1 2" : undefined}
          />
        ))}

        {/* Radial spokes */}
        {spokes.map((a, i) => {
          const x2 = cx + Math.cos(a - Math.PI / 2) * 92;
          const y2 = cy + Math.sin(a - Math.PI / 2) * 92;
          return (
            <line
              key={i}
              x1={cx}
              y1={cy}
              x2={x2}
              y2={y2}
              stroke="var(--color-rule-strong)"
              strokeWidth={0.5}
            />
          );
        })}

        {/* Sweeping wedge (rotates) */}
        <g className="hero-radar-spin">
          <rect
            x={0}
            y={0}
            width={200}
            height={200}
            fill="url(#hero-radar-sweep)"
            mask="url(#hero-radar-mask)"
          />
          <line
            x1={cx}
            y1={cy}
            x2={cx}
            y2={5}
            stroke="#EA580C"
            strokeWidth={1.2}
            strokeLinecap="round"
          />
          {/* Pulsing tip */}
          <circle cx={cx} cy={5} r={2.2} fill="#EA580C" className="hero-radar-tip" />
        </g>

        {/* Static highlighted sector under the wedge starting point */}
        <path
          d={`M ${cx} ${cy} L ${cx} 5 A 95 95 0 0 1 ${cx + 95 * Math.cos(-Math.PI / 2 + Math.PI / 6)} ${cy + 95 * Math.sin(-Math.PI / 2 + Math.PI / 6)} Z`}
          fill="#EA580C"
          fillOpacity={0.04}
        />

        {/* Centre dot */}
        <circle cx={cx} cy={cy} r={1.8} fill="var(--color-ink)" />
      </svg>
    </div>
  );
}
