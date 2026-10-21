"use client";

import { brandColor } from "@/lib/brand";
import {
  type CostModel,
  type Market,
  MOVE_RANGE,
  papertradeKeep,
  venueLabel,
} from "@/lib/perp-cost-model";
import { lineColor } from "@/lib/series-colors";

const W = 760;
const H = 300;
const PAD = { top: 16, right: 18, bottom: 40, left: 62 };
const PLOT = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom };

/** The slider's full span, so the chart does not move when the slider does. */
const MAX_MOVE = MOVE_RANGE.max / 1000 / 100;

function compactUsd(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `$${Math.round(v / 1e3)}k`;
  if (a >= 100) return `$${Math.round(v)}`;
  if (a === 0) return "$0";
  return `$${v.toFixed(a < 10 ? 2 : 1)}`;
}

/**
 * Ticks a reader recognises. Quartering the axis gave $247 and 0.16%, which
 * are correct and unreadable; this walks 1, 2 or 5 times a power of ten so
 * every label lands on a round number.
 */
function niceTicks(max: number, target: number): number[] {
  if (!(max > 0)) return [0];
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const step = (normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1) * magnitude;
  const ticks: number[] = [];
  for (let v = 0; v <= max * 1.0001; v += step) ticks.push(v);
  return ticks;
}

/**
 * A series takes the venue's own brand colour when we have one, and a palette
 * slot otherwise. Exported so the legend beside the chart cannot drift from
 * the lines it is labelling.
 */
export function seriesColor(logoKey: string, i: number): string {
  return brandColor(logoKey) ?? lineColor(i);
}

/**
 * Why the ranking flips, drawn.
 *
 * A fee on notional does not care how far the price travels, so every
 * notional-fee venue is a horizontal line. A fee on the gain grows with the
 * gain, so Papertrade is a curve out of the origin. The curve therefore
 * crosses each line exactly once, and that crossing is the whole argument of
 * the page: left of it the gain fee is cheaper, right of it the flat fee is.
 *
 * The x span is the slider's whole range and not the current value, so
 * dragging the slider moves the marker across a chart that holds still.
 */
export function PerpCostChart({ model, market }: { model: CostModel; market: Market }) {
  const papertrade = model.live.find((r) => r.venue.charges === "gain") ?? null;
  const flats = model.live.filter((r) => r.venue.charges === "notional");

  const gainCostAt = (move: number) =>
    move * model.notional * (1 - papertradeKeep(market, move));
  const flatMax = flats.length > 0 ? Math.max(...flats.map((r) => r.cost)) : 0;

  /**
   * The frame, which is the whole readability of this chart.
   *
   * Drawn across the slider's full 2% the curve climbs to six times the flat
   * lines, so the crossing, the one thing worth seeing, was squashed into the
   * bottom eighth. So the x span is the region where the two are comparable:
   * a few multiples of the crossover, never less than where the slider
   * currently sits, and never more than the slider's own maximum. The y span
   * then follows the curve's height at that edge, so the plot always fills.
   */
  const xMax = Math.min(
    MAX_MOVE,
    Math.max(
      model.move * 1.3,
      model.crossoverMove !== null ? model.crossoverMove * 3 : 0,
      MAX_MOVE / 8,
    ),
  );
  const curveMax = papertrade ? gainCostAt(xMax) : 0;
  const yMax = Math.max(curveMax, flatMax, 1e-9) * 1.1;
  const zoomed = xMax < MAX_MOVE * 0.999;

  const x = (move: number) => PAD.left + (move / xMax) * PLOT.w;
  const y = (cost: number) => PAD.top + PLOT.h - (cost / yMax) * PLOT.h;

  const curve = papertrade
    ? Array.from({ length: 121 }, (_, i) => {
        const move = (i / 120) * xMax;
        return `${i === 0 ? "M" : "L"}${x(move).toFixed(1)} ${y(gainCostAt(move)).toFixed(1)}`;
      }).join(" ")
    : null;

  const colorOf = seriesColor;
  const ptColor = colorOf("papertrade", 0);

  const xTicks = niceTicks(xMax, 4);
  const xTickDigits = xMax >= 0.01 ? 1 : xMax >= 0.002 ? 2 : 3;
  const yTicks = niceTicks(yMax, 2);

  const crossX = model.crossoverMove !== null ? x(model.crossoverMove) : null;
  const crossY =
    model.crossoverMove !== null && model.rival !== null ? y(model.rival.cost) : null;
  // A crossover past the slider's own range cannot be drawn honestly.
  const crossInRange = model.crossoverMove !== null && model.crossoverMove <= MAX_MOVE;

  const nowX = x(Math.min(model.move, xMax));

  const summary = papertrade
    ? `Cost of the trade as the price move grows, from zero to 2% of price. ${venueLabel(
        papertrade.venue,
      )} is a curve from the origin because it charges on the gain. ${
        flats.length > 0
          ? `${flats.length} venue${flats.length > 1 ? "s" : ""} charging on notional are flat lines.`
          : "No notional-fee venue is open at this leverage."
      }${
        crossInRange && model.rival
          ? ` The curve crosses ${venueLabel(model.rival.venue)} at a ${(
              model.crossoverMove! * 100
            ).toFixed(3)}% move.`
          : ""
      }`
    : "Cost of the trade as the price move grows. Every open venue charges on notional, so every line is flat.";

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={summary}
        style={{ height: "auto", display: "block", overflow: "visible" }}
      >
        {/* Horizontal guides and the dollar scale */}
        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line
              x1={PAD.left}
              x2={PAD.left + PLOT.w}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--color-rule)"
              strokeWidth={i === 0 ? 1 : 0.8}
              strokeDasharray={i === 0 ? undefined : "3 4"}
            />
            <text
              x={PAD.left - 8}
              y={y(t) + 3.5}
              textAnchor="end"
              fontSize={10}
              fontFamily="var(--font-mono)"
              fill="var(--color-ink-faint)"
            >
              {compactUsd(t)}
            </text>
          </g>
        ))}

        {/* The price move scale */}
        {xTicks.map((t) => (
          <text
            key={`x${t}`}
            x={x(t)}
            y={PAD.top + PLOT.h + 16}
            textAnchor={t === 0 ? "start" : t >= xMax ? "end" : "middle"}
            fontSize={10}
            fontFamily="var(--font-mono)"
            fill="var(--color-ink-faint)"
          >
            {(t * 100).toFixed(t === 0 ? 0 : xTickDigits)}%
          </text>
        ))}
        {/* One flat line per notional-fee venue. The cheapest is the one the
            crossover is measured against, so it is the only labelled line. */}
        {flats.map((row, i) => {
          const isRival = model.rival !== null && row.venue.id === model.rival.venue.id;
          const color = colorOf(row.venue.logoKey, i + 1);
          return (
            <g key={row.venue.id}>
              <line
                x1={PAD.left}
                x2={PAD.left + PLOT.w}
                y1={y(row.cost)}
                y2={y(row.cost)}
                stroke={color}
                strokeWidth={isRival ? 2 : 1}
                strokeOpacity={isRival ? 1 : 0.38}
              />
              {isRival && (
                <text
                  x={PAD.left + PLOT.w - 4}
                  y={y(row.cost) - 7}
                  textAnchor="end"
                  fontSize={11}
                  fontFamily="var(--font-mono)"
                  fill={color}
                >
                  {venueLabel(row.venue)} {compactUsd(row.cost)}
                </text>
              )}
            </g>
          );
        })}

        {/* The gain fee */}
        {curve && (
            <path d={curve} fill="none" stroke={ptColor} strokeWidth={2.4} />
        )}

        {/* Where they cross */}
        {crossInRange && crossX !== null && crossY !== null && (
          <g>
            <line
              x1={crossX}
              x2={crossX}
              y1={PAD.top}
              y2={PAD.top + PLOT.h}
              stroke="var(--color-ink-faint)"
              strokeWidth={1}
              strokeDasharray="2 3"
            />
            <circle cx={crossX} cy={crossY} r={4.5} fill="var(--color-paper)" />
            <circle
              cx={crossX}
              cy={crossY}
              r={4.5}
              fill="none"
              stroke="var(--color-ink)"
              strokeWidth={1.6}
            />
            <text
              x={crossX + 7}
              y={PAD.top + 11}
              fontSize={10.5}
              fontFamily="var(--font-mono)"
              fill="var(--color-ink)"
            >
              crosses at {(model.crossoverMove! * 100).toFixed(3)}%
            </text>
          </g>
        )}

        {/* Where the slider currently sits */}
        <line
          x1={nowX}
          x2={nowX}
          y1={PAD.top}
          y2={PAD.top + PLOT.h}
          stroke="var(--color-accent)"
          strokeWidth={1.4}
        />
        {model.live.map((row, i) => (
          <circle
            key={`now-${row.venue.id}`}
            cx={nowX}
            cy={y(row.cost)}
            r={3}
            fill={colorOf(row.venue.logoKey, row.venue.charges === "gain" ? 0 : i + 1)}
          />
        ))}
        <text
          x={nowX}
          y={PAD.top + PLOT.h + 31}
          textAnchor="middle"
          fontSize={10}
          fontFamily="var(--font-mono)"
          fill="var(--color-accent)"
        >
          you are here
        </text>
      </svg>

      {/* The first version of this caption said the curve bends because the
          fee grows with the gain. That does not follow: a constant share of a
          gain that is itself linear in the move is a straight line through the
          origin, so "grows with the gain" predicts a line, not a curve. What
          actually bends it is that Papertrade's share is not constant. It
          climbs with the move, from nothing at the deadband toward 11.8 per
          cent, so the slope rises and then flattens. Saying it correctly costs
          one sentence and is the only reason the two lines cross where they
          do. */}
      <figcaption className="mt-1 text-xs leading-snug text-ink-faint">
        A fee on notional does not move with the price, so it draws a flat line. The curve is not
        simply a share of the gain, which would be a straight line too: it bends because the share
        itself climbs with the move, from nothing at the deadband toward 11.8%. They cross once.
        {zoomed
          ? ` Framed on the region where the two are comparable, up to a ${(xMax * 100).toFixed(
              2,
            )}% move; the slider runs to 2%.`
          : ""}
      </figcaption>
    </figure>
  );
}
