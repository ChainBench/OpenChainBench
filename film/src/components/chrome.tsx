import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { LogoSphere } from "./LogoSphere";
import { inOutCubic, phase, slam } from "../motion";
import { C, F } from "../theme";

export const PAD = 118;

/** Two or three frames of accent light on a cut. */
export function Flash({ at, len = 4 }: { at: number; len?: number }) {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [at, at + 1, at + len], [0, 0.42, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (o <= 0) return null;
  return <AbsoluteFill style={{ background: C.accent, opacity: o, mixBlendMode: "screen" }} />;
}

/**
 * The mark crossing frame, used as the cut itself: it enters oversized and
 * spinning, painted in negative so it reads as an object passing in front of
 * the picture rather than as a hole in it.
 */
export function SphereWipe({ at, dir = 1 }: { at: number; dir?: 1 | -1 }) {
  const frame = useCurrentFrame();
  const t = phase(frame, at, at + 17, inOutCubic);
  if (t <= 0 || t >= 1) return null;
  const x = interpolate(t, [0, 1], [-1600 * dir, 2000 * dir]);
  const spin = interpolate(t, [0, 1], [0, 5.2 * dir]);
  const scale = interpolate(t, [0, 0.5, 1], [1.5, 2.4, 1.5]);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
      <div style={{ transform: `translateX(${x}px) scale(${scale})` }}>
        <LogoSphere size={620} rotationY={spin} rotationX={0.1} glow={0.35} surface={C.accent} ink={C.paper} />
      </div>
    </AbsoluteFill>
  );
}

export function Eyebrow({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = slam(frame, fps, delay);
  return (
    <div
      style={{
        fontFamily: F.mono,
        fontSize: 22,
        letterSpacing: "0.38em",
        textTransform: "uppercase",
        color: C.accent,
        opacity: Math.min(1, t * 1.4),
        transform: `translateX(${(1 - t) * -40}px)`,
      }}
    >
      {children}
    </div>
  );
}

export function Claim({
  children,
  delay = 0,
  size = 74,
}: {
  children: React.ReactNode;
  delay?: number;
  size?: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = slam(frame, fps, delay);
  return (
    <div
      style={{
        fontFamily: F.display,
        fontWeight: 700,
        fontSize: size,
        lineHeight: 1.02,
        letterSpacing: "-0.035em",
        color: C.ink,
        opacity: Math.min(1, t * 1.6),
        transform: `translateY(${(1 - t) * 30}px) scale(${interpolate(t, [0, 1], [1.05, 1])})`,
        transformOrigin: "left center",
      }}
    >
      {children}
    </div>
  );
}

export function Footer({ right }: { right: string }) {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        left: PAD,
        right: PAD,
        bottom: 44,
        display: "flex",
        justifyContent: "space-between",
        fontFamily: F.mono,
        fontSize: 19,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: C.inkFaint,
        opacity: phase(frame, 10, 24),
      }}
    >
      <span>openchainbench.com</span>
      <span>{right}</span>
    </div>
  );
}

/**
 * The header every act shares: what the category is, in the site's own words,
 * and what this particular bench asks.
 *
 * The category line is an explanation, not a label, so it is held while the
 * viewer reads it and then gets out of the way of the demo underneath.
 */
export function ActHeader({
  category,
  categoryLine,
  claim,
  benchesInCategory,
}: {
  category: string;
  categoryLine: string;
  claim: string;
  benchesInCategory: number;
}) {
  const frame = useCurrentFrame();
  const lineOut = interpolate(frame, [52, 66], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const lift = interpolate(frame, [52, 68], [0, -46], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: inOutCubic,
  });

  return (
    <div style={{ transform: `translateY(${lift}px)` }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
        <Eyebrow>{category}</Eyebrow>
        <span
          style={{
            fontFamily: F.mono,
            fontSize: 18,
            color: C.inkFaint,
            letterSpacing: "0.1em",
            opacity: phase(frame, 6, 18) * lineOut,
          }}
        >
          {benchesInCategory} live benchmarks
        </span>
      </div>
      <div style={{ height: 10 }} />
      <div
        style={{
          fontFamily: F.sans,
          fontSize: 27,
          lineHeight: 1.3,
          color: C.inkMuted,
          maxWidth: 1180,
          height: lineOut > 0 ? "auto" : 0,
          opacity: phase(frame, 8, 22) * lineOut,
          overflow: "hidden",
        }}
      >
        {categoryLine}.
      </div>
      <div style={{ height: 14 }} />
      <Claim delay={16}>{claim}</Claim>
    </div>
  );
}

/**
 * The frame every act shares: header at the top, demo centred in the rest.
 * Without this each act flowed from the top and left the bottom third of the
 * frame empty, which read as an unfinished slide rather than a composition.
 */
export function ActShell({
  header,
  children,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        padding: `70px ${PAD}px 120px`,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {header}
      <div style={{ flex: 1, display: "flex", alignItems: "center", minHeight: 0 }}>
        <div style={{ width: "100%" }}>{children}</div>
      </div>
    </div>
  );
}
