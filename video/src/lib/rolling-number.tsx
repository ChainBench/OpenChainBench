import { formatValue } from "./formatters";

/**
 * Odometer-style value label. Each digit is a vertical 0-9 wheel whose
 * offset derives continuously from the underlying value: the lowest
 * wheel spins, higher wheels creep, exactly like a mechanical counter.
 *
 * Stateless on purpose — Remotion renders frames out of order, so the
 * wheel position must be a pure function of the value. For the digit of
 * display-weight w the wheel offset is simply (displayValue / w) mod 10.
 *
 * Falls back to the plain formatted string for shapes that don't carry
 * a single decimal number ("1m 30s", "$2e-6", "—", zero/negative).
 */
const WHEEL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

export const RollingNumber: React.FC<{
  value: number;
  unit: string;
  /** Wheel window height in px — pass the label's font size. */
  fontSize: number;
}> = ({ value, unit, fontSize }) => {
  const text = formatValue(value, unit);
  const m = text.match(/\d+(?:\.\d+)?/);
  if (
    !m ||
    m.index === undefined ||
    !Number.isFinite(value) ||
    value <= 0 ||
    text.includes("e") ||
    /\dm \d/.test(text) // "1m 30s" minute format: two numbers, skip
  ) {
    return <>{text}</>;
  }

  const shown = parseFloat(m[0]);
  if (!(shown > 0)) return <>{text}</>;

  // formatValue rounds AND rescales (ms→s, →k/M…). Recover the display
  // scale from the rounded number — scales are powers of 10, so snapping
  // the ratio to the nearest power recovers it exactly despite rounding.
  const scale = Math.pow(10, Math.round(Math.log10(shown / value)));
  const cont = value * scale;

  const num = m[0];
  const pre = text.slice(0, m.index);
  const post = text.slice(m.index + num.length);
  const intLen = num.includes(".") ? num.indexOf(".") : num.length;

  const H = Math.round(fontSize * 1.12);
  let digitPos = 0;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        whiteSpace: "pre",
        fontVariantNumeric: "tabular-nums",
        lineHeight: `${H}px`,
      }}
    >
      {pre}
      {num.split("").map((ch, i) => {
        if (ch === ".") {
          return <span key={i}>.</span>;
        }
        const weight = Math.pow(10, intLen - 1 - digitPos);
        digitPos += 1;
        // Carry-based roll, like a mechanical counter: a wheel sits flat
        // on its digit and only rotates while the wheel below sweeps its
        // last 15% (the carry window). Continuous (cont / w) % 10 on
        // every wheel left ALL digits half-cut at any paused frame.
        const x = (cont / weight) % 10;
        const d = Math.floor(x);
        const f = x - d;
        const carry = f > 0.85 ? (f - 0.85) / 0.15 : 0;
        const wheel = d + carry * carry * (3 - 2 * carry); // smoothstep
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              overflow: "hidden",
              height: H,
              width: "1ch",
              textAlign: "center",
            }}
          >
            <span
              style={{
                display: "block",
                transform: `translateY(${(-wheel * H).toFixed(2)}px)`,
              }}
            >
              {WHEEL.map((d, k) => (
                <span
                  key={k}
                  style={{ display: "block", height: H, lineHeight: `${H}px` }}
                >
                  {d}
                </span>
              ))}
            </span>
          </span>
        );
      })}
      {post}
    </span>
  );
};
