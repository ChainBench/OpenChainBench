import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { LogoSphere } from "../components/LogoSphere";
import { Claim, Eyebrow, Flash, Footer, PAD, SphereWipe } from "../components/chrome";
import { Backdrop, CountUp, Mark } from "../components/ui";
import { FILM } from "../data";
import { outCubic, outQuint, phase, slam } from "../motion";
import { C, F } from "../theme";

/** Every mark the film touches, for the shot that needs a crowd not a row. */
const ALL_LOGOS: string[] = Array.from(
  new Set(
    [
      ...FILM.acts.flatMap((a) => a.field.map((f) => f.logo)),
      ...FILM.rpc.top.map((r) => r.logo),
    ].filter(Boolean) as string[],
  ),
);

// ── The mark arrives ──────────────────────────────────────────────────
export function ColdOpen() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const pull = phase(frame, 0, 62, outQuint);
  const scale = interpolate(pull, [0, 1], [5.2, 1]);
  // It never stops turning: a sphere that holds still is a disc with a picture
  // on it, which is how the first cut of this film read.
  const spin = interpolate(pull, [0, 1], [-11.5, 0]) + frame * 0.012;
  const tilt = 0.14 + Math.sin(frame / 42) * 0.06;
  const glow = interpolate(frame, [0, 30, 62, 96], [1, 0.8, 0.25, 0.14], { extrapolateRight: "clamp" });
  const lift = interpolate(phase(frame, 50, 80, outCubic), [0, 1], [0, -150]);
  const titleT = slam(frame, fps, 56);

  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ transform: `translateY(${lift}px) scale(${scale})` }}>
          <LogoSphere size={470} rotationY={spin} rotationX={tilt} glow={glow} />
        </div>
      </AbsoluteFill>

      <Flash at={56} len={7} />

      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            marginTop: 330,
            textAlign: "center",
            opacity: Math.min(1, titleT * 1.6),
            transform: `scale(${interpolate(titleT, [0, 1], [1.14, 1])})`,
          }}
        >
          <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 94, letterSpacing: "-0.035em", color: C.ink }}>
            OpenChainBench
          </div>
          <div
            style={{
              fontFamily: F.mono,
              fontSize: 25,
              letterSpacing: "0.3em",
              textTransform: "uppercase",
              color: C.inkFaint,
              marginTop: 16,
              opacity: phase(frame, 70, 86),
            }}
          >
            Measured, not claimed
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
}

// ── The field ─────────────────────────────────────────────────────────
/**
 * "155 products ranked" is a number nobody feels. The same claim made of the
 * actual marks, drifting in bands above and below the type, says what this
 * site does before a word is read. The bands never cross the text: the first
 * attempt ran one through the headline and the crowd ate the sentence.
 */
export function Crowd() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const bands = [
    { y: 70, size: 86, speed: 1.6, opacity: 0.42, offset: 0 },
    { y: 196, size: 118, speed: 2.6, opacity: 0.72, offset: 7 },
    { y: 788, size: 104, speed: -2.1, opacity: 0.6, offset: 3 },
    { y: 928, size: 78, speed: -1.3, opacity: 0.36, offset: 11 },
  ];

  return (
    <Backdrop>
      {bands.map((b, bi) => (
        <div key={bi} style={{ position: "absolute", left: 0, top: b.y, height: b.size }}>
          {ALL_LOGOS.map((logo, i) => {
            const spacing = b.size + 72;
            const total = ALL_LOGOS.length * spacing;
            const raw = (i + b.offset) * spacing - frame * b.speed;
            const x = ((raw % total) + total) % total - spacing;
            return (
              <div key={logo + bi} style={{ position: "absolute", left: x, opacity: b.opacity }}>
                <Mark logo={logo} size={b.size} />
              </div>
            );
          })}
        </div>
      ))}

      <AbsoluteFill
        style={{ background: `linear-gradient(180deg, ${C.paper} 1%, transparent 16%, transparent 84%, ${C.paper} 99%)` }}
      />
      <AbsoluteFill
        style={{ background: `linear-gradient(180deg, transparent 26%, ${C.paper} 34%, ${C.paper} 70%, transparent 78%)` }}
      />

      <AbsoluteFill style={{ padding: PAD, justifyContent: "center" }}>
        <Eyebrow>Nobody takes anyone&apos;s word for it</Eyebrow>
        <div style={{ height: 22 }} />
        <Claim delay={4} size={98}>
          {FILM.totals.products} products.
          <br />
          {FILM.totals.benchmarks} live benchmarks.
        </Claim>
        <div style={{ height: 34 }} />
        <div style={{ display: "flex", gap: 68 }}>
          {([
            [FILM.totals.rpcChains, "chains probed"],
            [FILM.totals.samples / 1e9, "billion measurements"],
            [FILM.totals.categories, "categories"],
          ] as const).map(([v, label], i) => {
            const k = slam(frame, fps, 26 + i * 6);
            return (
              <div
                key={label}
                style={{
                  opacity: Math.min(1, k * 1.6),
                  transform: `translateY(${(1 - k) * 22}px) scale(${interpolate(k, [0, 1], [1.2, 1])})`,
                  transformOrigin: "left bottom",
                }}
              >
                <CountUp
                  to={v}
                  delay={26 + i * 6}
                  duration={24}
                  format={(x) => (label.startsWith("billion") ? x.toFixed(1) : Math.round(x).toString())}
                  style={{ fontSize: 74, color: C.ink, display: "block" }}
                />
                <div
                  style={{
                    fontFamily: F.mono,
                    fontSize: 20,
                    color: C.inkFaint,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                  }}
                >
                  {label}
                </div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
      <Footer right="measured, not claimed" />
    </Backdrop>
  );
}

// ── Breadth ───────────────────────────────────────────────────────────
/**
 * RPCs do not get a race either. The claim here is breadth, so the picture is
 * every chain at once: one cell per live chain benchmark, filling in, and then
 * the tally of who leads the most of them.
 */
export function RpcAct() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const top = FILM.rpc.top;
  const max = Math.max(...top.map((r) => r.chains));
  const cells = FILM.rpc.chains;
  const cols = 30;
  const lit = Math.floor(phase(frame, 22, 74, outCubic) * cells);
  const grow = phase(frame, 70, 118, outCubic);

  return (
    <Backdrop>
      <div style={{ position: "absolute", left: PAD, right: PAD, top: 76 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
          <Eyebrow>RPCs</Eyebrow>
          <span style={{ fontFamily: F.mono, fontSize: 18, color: C.inkFaint, letterSpacing: "0.1em" }}>
            {FILM.rpc.chains} live benchmarks
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
            opacity: phase(frame, 8, 22),
          }}
        >
          {FILM.rpc.categoryLine}.
        </div>
        <div style={{ height: 16 }} />
        <Claim delay={14}>One chain, one grid cell</Claim>

        {/* Every chain we probe, lighting up. */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 28, width: cols * 29 }}>
          {Array.from({ length: cells }).map((_, i) => (
            <div
              key={i}
              style={{
                width: 22,
                height: 22,
                borderRadius: 3,
                background: i < lit ? C.accent : C.surface,
                opacity: i < lit ? 0.35 + (i % 7) * 0.09 : 1,
              }}
            />
          ))}
        </div>

        <div
          style={{
            position: "absolute",
            right: 0,
            top: 236,
            width: 740,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {top.map((r, i) => {
            const e = slam(frame, fps, 70 + i * 4);
            return (
              <div
                key={r.slug}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  opacity: Math.min(1, e * 1.5),
                  transform: `translateX(${(1 - e) * 60}px)`,
                }}
              >
                <Mark logo={r.logo} size={44} />
                <div style={{ width: 200, fontFamily: F.display, fontWeight: 700, fontSize: 30, color: C.ink }}>
                  {r.name}
                </div>
                <div style={{ flex: 1, height: 22, background: C.surface, borderRadius: 3 }}>
                  <div
                    style={{
                      width: `${(r.chains / max) * 100 * grow}%`,
                      height: "100%",
                      background: i === 0 ? `linear-gradient(90deg, ${C.accentSoft}, ${C.accent})` : C.ruleStrong,
                      borderRadius: 3,
                    }}
                  />
                </div>
                <div
                  style={{
                    width: 140,
                    textAlign: "right",
                    fontFamily: F.display,
                    fontWeight: 700,
                    fontSize: 30,
                    color: i === 0 ? C.accent : C.inkSoft,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <CountUp to={r.chains} delay={70 + i * 4} duration={26} format={(v) => Math.round(v).toString()} />
                  <span style={{ fontSize: 17, color: C.inkFaint, marginLeft: 6 }}>led</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <Footer right="chains led, counted from live benchmarks" />
      <SphereWipe at={0} dir={1} />
      <Flash at={14} />
    </Backdrop>
  );
}

// ── What you can do with it ───────────────────────────────────────────
const USES: Array<[string, string]> = [
  ["JSON API", "every bench, every leader, no key"],
  ["MCP server", "point an agent at the live numbers"],
  ["Badges", "a measured claim on your own site"],
  ["Citations", "APA, BibTeX, RIS, dated"],
  ["Compare pages", "any two products, side by side"],
  ["Open harnesses", "the code that took the measurement"],
];

export function UsesAct() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const spin = interpolate(frame, [0, 130], [-0.7, 0.7]);

  return (
    <Backdrop>
      <div style={{ position: "absolute", right: -130, bottom: -150, opacity: 0.3 }}>
        <LogoSphere size={620} rotationY={spin} rotationX={0.14} glow={0.45} />
      </div>

      <AbsoluteFill style={{ padding: PAD, justifyContent: "center" }}>
        <Eyebrow>Take it with you</Eyebrow>
        <div style={{ height: 18 }} />
        <Claim delay={3} size={84}>
          The numbers are yours too
        </Claim>
        <div style={{ height: 44 }} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "22px 66px", maxWidth: 1420 }}>
          {USES.map(([name, what], i) => {
            const e = slam(frame, fps, 14 + i * 4);
            return (
              <div
                key={name}
                style={{
                  borderLeft: `3px solid ${C.accent}`,
                  paddingLeft: 22,
                  opacity: Math.min(1, e * 1.6),
                  transform: `translateX(${(1 - e) * -44}px)`,
                }}
              >
                <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 42, color: C.ink, letterSpacing: "-0.02em" }}>
                  {name}
                </div>
                <div style={{ fontFamily: F.sans, fontSize: 24, color: C.inkMuted, marginTop: 2 }}>{what}</div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
      <Footer right="no key, no sign-up" />
      <SphereWipe at={0} dir={-1} />
      <Flash at={14} />
    </Backdrop>
  );
}

// ── Close ─────────────────────────────────────────────────────────────
export function Close() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const roll = phase(frame, 0, 54, outQuint);
  const x = interpolate(roll, [0, 1], [-1150, 0]);
  const spin = interpolate(roll, [0, 1], [-6.4, 0]) + frame * 0.014;
  const tilt = 0.12 + Math.sin(frame / 38) * 0.05;
  const glow = interpolate(frame, [0, 60, 110], [0.15, 0.5, 0.75], { extrapolateRight: "clamp" });
  const t = slam(frame, fps, 50);

  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ marginTop: -210, transform: `translateX(${x}px)` }}>
          <LogoSphere size={400} rotationY={spin} rotationX={tilt} glow={glow} />
        </div>
      </AbsoluteFill>
      <Flash at={52} len={6} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            marginTop: 300,
            textAlign: "center",
            opacity: Math.min(1, t * 1.6),
            transform: `scale(${interpolate(t, [0, 1], [1.12, 1])})`,
          }}
        >
          <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 82, letterSpacing: "-0.035em", color: C.ink }}>
            openchainbench.com
          </div>
          <div
            style={{
              fontFamily: F.mono,
              fontSize: 22,
              letterSpacing: "0.26em",
              textTransform: "uppercase",
              color: C.inkFaint,
              marginTop: 16,
              opacity: phase(frame, 62, 78),
            }}
          >
            Open data · CC BY 4.0 · {FILM.asOf ? FILM.asOf.slice(0, 10) : ""}
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
}
