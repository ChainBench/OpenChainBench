import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "RPC Speed Test by OpenChainBench";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Same dial geometry as the live tool, rendered once for the social
// card. Static content: cache aggressively (content only changes on
// deploy).
const GAUGE_START = -210;
const GAUGE_SWEEP = 240;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}
function msToAngle(ms: number): number {
  const t = Math.log(Math.max(1, Math.min(1000, ms))) / Math.log(1000);
  return GAUGE_START + t * GAUGE_SWEEP;
}
const GRAD: [number, [number, number, number]][] = [
  [0.0, [16, 185, 129]],
  [0.55, [245, 158, 11]],
  [1.0, [239, 68, 68]],
];
function gradColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < GRAD.length; i++) {
    const [t1, c1] = GRAD[i];
    const [t0, c0] = GRAD[i - 1];
    if (x <= t1) {
      const f = (x - t0) / (t1 - t0);
      const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * f));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return "rgb(239,68,68)";
}

export default function OG() {
  const READING = 42; // ms, needle in the green
  const angle = msToAngle(READING);
  const fillT = (angle - GAUGE_START) / GAUGE_SWEEP;
  const SEGS = 48;
  const segs: { d: string; color: string }[] = [];
  for (let i = 0; i < SEGS; i++) {
    const t0 = i / SEGS;
    if (t0 >= fillT) break;
    const t1 = Math.min((i + 1) / SEGS, fillT);
    segs.push({
      d: arcPath(210, 210, 160, GAUGE_START + t0 * GAUGE_SWEEP, GAUGE_START + t1 * GAUGE_SWEEP + 0.6),
      color: gradColor(t0),
    });
  }
  const [nx, ny] = polar(210, 210, 128, angle);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#f8f3eb",
          color: "#1c1a17",
          padding: 64,
          alignItems: "center",
          fontFamily: "Georgia, serif",
        }}
      >
        {/* Dial: svg for the arcs/needle, HTML overlay for the readout
            (satori does not support svg <text> nodes). */}
        <div style={{ display: "flex", position: "relative", width: 420, height: 420 }}>
        <svg width="420" height="420" viewBox="0 0 420 420">
          <path
            d={arcPath(210, 210, 160, GAUGE_START, GAUGE_START + GAUGE_SWEEP)}
            fill="none"
            stroke="#e5ddd0"
            strokeWidth="28"
            strokeLinecap="round"
          />
          {segs.map((s, i) => (
            <path
              key={i}
              d={s.d}
              fill="none"
              stroke={s.color}
              strokeWidth="28"
              strokeLinecap={i === 0 ? "round" : "butt"}
            />
          ))}
          <line x1="210" y1="210" x2={nx} y2={ny} stroke="#1c1a17" strokeWidth="7" strokeLinecap="round" />
          <circle cx="210" cy="210" r="12" fill="#1c1a17" />
        </svg>
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 252,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", fontSize: 66, color: "#1c1a17" }}>{READING}</div>
            <div style={{ display: "flex", fontSize: 24, color: "#8a8378" }}>ms</div>
          </div>
        </div>

        {/* Copy */}
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 48, flex: 1 }}>
          <div style={{ fontSize: 26, textTransform: "uppercase", letterSpacing: 6, color: "#8a8378" }}>
            Free browser tool
          </div>
          <div style={{ fontSize: 78, fontWeight: 700, lineHeight: 1.05, marginTop: 16 }}>
            RPC Speed Test
          </div>
          <div style={{ fontSize: 30, color: "#57514a", marginTop: 22, lineHeight: 1.35 }}>
            Benchmark any RPC endpoints from your own connection. 87 EVM
            chains, keys never leave your browser.
          </div>
          <div style={{ display: "flex", alignItems: "center", marginTop: 40, fontSize: 26, color: "#8a8378" }}>
            openchainbench.com/speedtest-rpc
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      headers: {
        "cache-control": "public, s-maxage=86400, stale-while-revalidate=604800",
      },
    },
  );
}
