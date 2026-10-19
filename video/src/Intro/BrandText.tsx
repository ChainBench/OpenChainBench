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

  const color = theme === "dark" ? "#ffffff" : "#0a0b0d";

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        // Portrait: the sphere sits centered; park the wordmark just under
        // it (~21% from the bottom) instead of pinned to the very bottom.
        paddingBottom: isPortrait ? Math.round(height * 0.21) : 180,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          opacity,
          transform: `translateY(${drift}px)`,
          fontFamily,
          fontWeight: 800,
          fontSize: isPortrait ? 88 : 132,
          letterSpacing: "-0.03em",
          color,
          textAlign: "center",
          lineHeight: 1,
        }}
      >
        OpenChainBench
      </div>
    </div>
  );
};
