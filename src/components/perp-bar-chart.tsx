import type { DailyBar } from "@/lib/perp-venue-external";

/**
 * Minimal SVG bar chart for the /perp/[slug] volume & fees panels.
 * Server component — no JS bundle cost, no hydration.
 */
export function PerpBarChart({
  bars,
  title,
  color = "teal",
}: {
  bars: DailyBar[];
  title: string;
  color?: "teal" | "cyan" | "indigo";
}) {
  const valid = bars.filter((b) => b.valueUsd > 0);
  if (valid.length < 3) return null;

  const max = Math.max(...valid.map((b) => b.valueUsd));
  if (max === 0) return null;

  const W = 600;
  const H = 72;
  const gap = 2;
  const barW = (W - gap * (valid.length - 1)) / valid.length;

  const fill =
    color === "cyan"
      ? "rgba(6,182,212,0.55)"
      : color === "indigo"
        ? "rgba(99,102,241,0.55)"
        : "rgba(20,184,166,0.55)";

  const fillHover =
    color === "cyan"
      ? "rgba(6,182,212,0.8)"
      : color === "indigo"
        ? "rgba(99,102,241,0.8)"
        : "rgba(20,184,166,0.8)";

  const first = valid[0]?.date ?? "";
  const last = valid[valid.length - 1]?.date ?? "";

  return (
    <div className="w-full">
      <p
        className="text-[10px] text-ink-faint uppercase tracking-wide mb-2"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {title}
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: 72 }}
        aria-hidden
        role="img"
      >
        {valid.map((bar, i) => {
          const h = Math.max(2, (bar.valueUsd / max) * H);
          const x = i * (barW + gap);
          const y = H - h;
          // Highlight the last bar (most recent day)
          const isLast = i === valid.length - 1;
          return (
            <rect
              key={bar.date}
              x={x}
              y={y}
              width={barW}
              height={h}
              fill={isLast ? fillHover : fill}
              rx={1}
            >
              <title>{`${bar.date}: ${fmtUsdShort(bar.valueUsd)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="flex justify-between mt-1">
        <span className="text-[9px] text-ink-faint">{fmtDate(first)}</span>
        <span className="text-[9px] text-ink-faint">{fmtDate(last)}</span>
      </div>
    </div>
  );
}

function fmtUsdShort(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(m) - 1]} ${parseInt(d)}`;
}
