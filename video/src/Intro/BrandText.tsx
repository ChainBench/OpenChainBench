import { useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont, fontFamily } from "@remotion/google-fonts/InterTight";
import { easeOutCubic, easeInOutCubic, remap } from "../lib/easing";

// Pre-load the brand font so the first render doesn't fall back to Noto.
// Remotion's google-fonts package handles caching + waitForFonts internally.
loadFont("normal", { weights: ["700", "800"] });

/**
 * "OpenChainBench" wordmark below the sphere. Fades in around the time the
 * sphere finishes its half-turn so the eye lands on the logo first, then
 * the brand name, in that order.
 */

const TEXT_IN_START = 18;
const TEXT_IN_END = 36;
const TEXT_OUT_START = 78;
const TEXT_OUT_END = 88;

export const BrandText: React.FC<{ theme: "light" | "dark" }> = ({ theme }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const isPortrait = height > width;

  const fadeIn = remap(frame, TEXT_IN_START, TEXT_IN_END, 0, 1, easeOutCubic);
  const fadeOut = 1 - remap(frame, TEXT_OUT_START, TEXT_OUT_END, 0, 1, easeInOutCubic);
  const opacity = fadeIn * fadeOut;

  // Slight upward drift as the text appears — gives the lockup a sense
  // of weight, like the letters are settling onto a baseline.
  const drift = remap(frame, TEXT_IN_START, TEXT_IN_END, 12, 0, easeOutCubic);

  // Brushed steel: a cool grey gradient clipped to the letters, and a
  // highlight band that sweeps across them once, after the mark's turn.
  const sweep = remap(frame, 44, 76, -60, 160, easeInOutCubic);
  const steel = theme === "dark"
    ? "linear-gradient(180deg, #ffffff 0%, #e4e7ec 38%, #9aa1ac 52%, #c9ced6 70%, #f1f3f6 100%)"
    : "linear-gradient(180deg, #3a3f47 0%, #15181d 50%, #4b515b 100%)";
  const shine = `linear-gradient(100deg, transparent ${sweep - 14}%, rgba(255,255,255,0.95) ${sweep}%, transparent ${sweep + 14}%)`;
  const letters: React.CSSProperties = {
    fontFamily,
    fontWeight: 800,
    fontSize: isPortrait ? 88 : 132,
    letterSpacing: "-0.03em",
    textAlign: "center",
    lineHeight: 1.1,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        // Portrait: the mark sits centered; park the wordmark just under
        // it (~21% from the bottom) instead of pinned to the very bottom.
        paddingBottom: isPortrait ? Math.round(height * 0.21) : 150,
        pointerEvents: "none",
      }}
    >
      <div style={{ position: "relative", opacity, transform: `translateY(${drift}px)` }}>
        <div style={{ ...letters, backgroundImage: steel, filter: "drop-shadow(0 6px 18px rgba(0,0,0,0.6))" }}>OpenChainBench</div>
        <div aria-hidden style={{ ...letters, position: "absolute", inset: 0, backgroundImage: shine }}>
          OpenChainBench
        </div>
      </div>
    </div>
  );
};
