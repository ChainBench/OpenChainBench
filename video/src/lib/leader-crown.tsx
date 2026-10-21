/**
 * Crown drawn as SVG. The 👑 emoji it replaces needs an emoji font, and
 * neither render box (Paris prod, SGP lab) has one: it printed as an
 * empty box in every leader pill and as nothing above the leader.
 */
export const CrownIcon: React.FC<{ size: number; color?: string; style?: React.CSSProperties }> = ({
  size,
  color = "#facc15",
  style,
}) => (
  <svg width={size} height={size * 0.8} viewBox="0 0 30 24" style={{ display: "inline-block", flexShrink: 0, ...style }} aria-hidden>
    <path d="M2 7 L8.5 13 L15 2.5 L21.5 13 L28 7 L25.5 20 H4.5 Z" fill={color} />
    <rect x="4.5" y="20.5" width="21" height="3" rx="1.2" fill={color} />
  </svg>
);

/**
 * Reusable crown that hovers above whichever provider is currently
 * leading. Each race composition computes the leader's screen position
 * per frame and passes (x, y) here — the crown rides along with a small
 * spring on enter + continuous float so it never feels static.
 *
 * Used by BarChartRace, TimeSeriesRace, DonutRace and
 * CountPodium so the visual language is consistent across the 5 views.
 */

import { easeOutCubic, remap } from "./easing";

export const LeaderCrown: React.FC<{
  /** Current Remotion frame. */
  frame: number;
  /** Centre-X of the crown. */
  x: number;
  /** Top-Y of the crown sticker (the emoji baseline sits ~size below). */
  y: number;
  /** Frame at which the crown should start fading in. */
  revealAt?: number;
  /** Pixel size of the emoji. Default 48 — small enough to feel like a badge, not a banner. */
  size?: number;
}> = ({ frame, x, y, revealAt = 18, size = 48 }) => {
  const enter = remap(frame, revealAt, revealAt + 24, 0, 1, easeOutCubic);
  if (enter <= 0) return null;
  const float = Math.sin((frame - revealAt) / 12) * 6;
  return (
    <div
      style={{
        position: "absolute",
        top: y + float,
        left: x - size / 2,
        width: size,
        display: "flex",
        justifyContent: "center",
        opacity: enter,
        transform: `scale(${0.5 + enter * 0.5}) rotate(${(1 - enter) * -12}deg)`,
        filter: "drop-shadow(0 4px 12px rgba(250, 204, 21, 0.3))",
        pointerEvents: "none",
        transition: "top 200ms cubic-bezier(0.16, 1, 0.3, 1), left 200ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      <CrownIcon size={size * 0.9} />
    </div>
  );
};
