import type { PercentileBucket } from "@/lib/benches/hyperliquid/builder-stats";

/**
 * Volume share by trader-rank percentile, 30d window. Renders as a
 * horizontal stacked bar (one bar, six segments) so the
 * "concentration vs. tail" story is visible at a glance — same
 * mental model as HyperTracker's "Volume by user percentile" widget.
 *
 * Server component (no hover required, plain SVG). Hovering surfaces
 * the segment label via the native `title` attribute on each rect.
 */

const BUCKET_LABELS: Record<PercentileBucket["bucket"], string> = {
  top1: "Top 1%",
  p1_5: "1 to 5%",
  p5_10: "5 to 10%",
  p10_25: "10 to 25%",
  p25_50: "25 to 50%",
  rest: "Bottom 50%",
};

const BUCKET_COLORS: Record<PercentileBucket["bucket"], string> = {
  top1: "#9d65ff",
  p1_5: "#b58bff",
  p5_10: "#c9a8ff",
  p10_25: "#dec6ff",
  p25_50: "#ece0ff",
  rest: "#f5eeff",
};

export function HlUserPercentile({
  shares,
  profitablePct,
}: {
  shares: PercentileBucket[];
  profitablePct: number;
}) {
  const total = shares.reduce((s, b) => s + b.share, 0);
  if (total <= 0) return null;

  return (
    <div className="card-soft rounded-xl p-4 sm:p-6 border border-ink/10">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
        <div>
          <p className="label-mono text-[10px] text-ink-faint">
            User concentration · last 30d
          </p>
          <p className="text-sm text-ink-faint mt-0.5">
            Share of routed volume by trader rank percentile
          </p>
        </div>
        {profitablePct > 0 && (
          <div className="text-right">
            <p
              className="label-mono text-[10px] text-ink-faint"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Profitable users
            </p>
            <p className="text-sm font-semibold tabular-nums text-ink">
              {(profitablePct * 100).toFixed(1)}%
            </p>
          </div>
        )}
      </div>

      <div className="w-full rounded-md overflow-hidden border border-ink/8 bg-paper-soft/30 h-8 flex">
        {shares.map((b) => {
          const w = (b.share / total) * 100;
          if (w <= 0) return null;
          return (
            <div
              key={b.bucket}
              style={{
                width: `${w}%`,
                background: BUCKET_COLORS[b.bucket],
              }}
              title={`${BUCKET_LABELS[b.bucket]} · ${(b.share * 100).toFixed(1)}%`}
              className="relative group transition-opacity hover:opacity-80"
            >
              {w >= 10 && (
                <span
                  className="absolute inset-0 flex items-center justify-center text-[10.5px] font-semibold text-ink/80 tabular-nums"
                  style={{ fontFamily: "var(--font-mono, monospace)" }}
                >
                  {(b.share * 100).toFixed(0)}%
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 grid grid-cols-3 sm:grid-cols-6 gap-2">
        {shares.map((b) => (
          <div key={b.bucket} className="flex items-center gap-1.5 min-w-0">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ background: BUCKET_COLORS[b.bucket] }}
              aria-hidden
            />
            <span className="text-[11px] text-ink-faint truncate">
              {BUCKET_LABELS[b.bucket]}
            </span>
            <span
              className="ml-auto text-[11px] tabular-nums text-ink shrink-0"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              {(b.share * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[11px] text-ink-faint italic">
        Read: a higher Top-1% segment means the frontend is more
        whale-driven; a long Bottom-50% tail means broader retail
        coverage.
      </p>
    </div>
  );
}
