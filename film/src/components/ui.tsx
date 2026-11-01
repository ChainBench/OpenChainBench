import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, F } from "../theme";

/**
 * The site's own ground: near-black with the radial dot pattern the body
 * carries, plus a vignette so the centre of frame reads brighter than the
 * edges on a phone screen.
 */
export function Backdrop({ children }: { children?: ReactNode }) {
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(${C.rule} 1.4px, transparent 1.4px)`,
          backgroundSize: "34px 34px",
          opacity: 0.5,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 50% 45%, transparent 35%, ${C.paper} 92%)`,
        }}
      />
      {children}
    </AbsoluteFill>
  );
}

/** A spring that starts at `delay` frames and settles without overshoot. */
export function useEnter(delay: number, damping = 200) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({
    frame: frame - delay,
    fps,
    config: { damping, mass: 0.6, stiffness: 110 },
  });
}

/** Rise and fade in, the film's one entrance gesture, used everywhere. */
export function Rise({
  delay = 0,
  distance = 28,
  children,
  style,
}: {
  delay?: number;
  distance?: number;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const t = useEnter(delay);
  return (
    <div
      style={{
        opacity: t,
        transform: `translateY(${(1 - t) * distance}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Eyebrow({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <Rise delay={delay} distance={14}>
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 22,
          letterSpacing: "0.34em",
          textTransform: "uppercase",
          color: C.accent,
        }}
      >
        {children}
      </div>
    </Rise>
  );
}

export function Title({
  children,
  delay = 0,
  size = 86,
  color = C.ink,
}: {
  children: ReactNode;
  delay?: number;
  size?: number;
  color?: string;
}) {
  return (
    <Rise delay={delay}>
      <div
        style={{
          fontFamily: F.display,
          fontWeight: 700,
          fontSize: size,
          lineHeight: 1.02,
          letterSpacing: "-0.03em",
          color,
        }}
      >
        {children}
      </div>
    </Rise>
  );
}

/**
 * A number that counts up to its value, then holds.
 *
 * `format` receives the eased value so the odometer can carry its own unit
 * and separators without this component knowing anything about them.
 */
export function CountUp({
  to,
  delay = 0,
  duration = 34,
  format,
  style,
}: {
  to: number;
  delay?: number;
  duration?: number;
  format: (v: number) => string;
  style?: CSSProperties;
}) {
  const frame = useCurrentFrame();
  const eased = interpolate(frame - delay, [0, duration], [0, to], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: (x) => 1 - Math.pow(1 - x, 3),
  });
  return (
    <span
      style={{
        fontFamily: F.display,
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "-0.02em",
        ...style,
      }}
    >
      {format(eased)}
    </span>
  );
}

/** A venue's mark, on the pale chip the site gives dark logos. */
export function Mark({ logo, size = 64 }: { logo: string | null; size?: number }) {
  if (!logo) return <div style={{ width: size, height: size }} />;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "#ffffff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        flexShrink: 0,
        boxShadow: `0 0 0 1px ${C.ruleStrong}`,
      }}
    >
      <Img
        src={staticFile(logo.replace(/^\//, ""))}
        style={{ width: size * 0.74, height: size * 0.74, objectFit: "contain" }}
      />
    </div>
  );
}

/** Hairline that draws itself left to right. */
export function Rule({ delay = 0, width = 1 }: { delay?: number; width?: number }) {
  const t = useEnter(delay);
  return (
    <div
      style={{
        height: width,
        background: C.rule,
        transform: `scaleX(${t})`,
        transformOrigin: "left center",
      }}
    />
  );
}
