import { fmtTick } from "./scales";

type YAxisProps = {
  yTicks: number[];
  lo: number;
  yRange: number;
  padL: number;
  padT: number;
  padR: number;
  innerH: number;
  W: number;
  unit: string;
};

export function YAxis({ yTicks, lo, yRange, padL, padT, padR, innerH, W, unit }: YAxisProps) {
  return (
    <>
      {yTicks.map((v, i) => {
        const y = padT + innerH * (1 - (v - lo) / yRange);
        const isBound = i === 0 || i === yTicks.length - 1;
        return (
          <g key={i}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y}
              y2={y}
              stroke="var(--color-rule)"
              strokeWidth={isBound ? 1 : 0.5}
              strokeDasharray={isBound ? "0" : "2 4"}
            />
            <text
              x={padL - 8}
              y={y}
              dominantBaseline="middle"
              textAnchor="end"
              fontFamily="var(--font-mono)"
              fontSize="10"
              fill="var(--color-ink-muted)"
            >
              {fmtTick(v, unit)}
            </text>
          </g>
        );
      })}
    </>
  );
}

type XAxisProps = {
  xTicks: { pct: number; label: string }[];
  padL: number;
  padT: number;
  innerW: number;
  innerH: number;
};

export function XAxis({ xTicks, padL, padT, innerW, innerH }: XAxisProps) {
  return (
    <>
      {xTicks.map((t, i) => {
        const x = padL + innerW * t.pct;
        return (
          <g key={i}>
            <line
              x1={x}
              x2={x}
              y1={padT + innerH}
              y2={padT + innerH + 4}
              stroke="var(--color-rule)"
              strokeWidth={0.8}
            />
            <text
              x={x}
              y={padT + innerH + 18}
              textAnchor={
                i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"
              }
              fontFamily="var(--font-mono)"
              fontSize="10"
              fill="var(--color-ink-muted)"
            >
              {t.label}
            </text>
          </g>
        );
      })}
    </>
  );
}
