"use client";

import { useMemo, useState } from "react";
import {
  computeCostModel,
  type CostRow,
  LEVERAGE_RANGE,
  type Market,
  MARGIN_RANGE,
  MOVE_RANGE,
  unavailableReason,
} from "@/lib/perp-cost-model";

// ── Formatting ────────────────────────────────────────────────────────────

function usd(value: number): string {
  const magnitude = Math.abs(value);
  const digits = magnitude < 100 ? 2 : 0;
  return `${value < 0 ? "-" : ""}$${magnitude.toLocaleString("en-US", {
    maximumFractionDigits: digits,
  })}`;
}

function pct(value: number, digits = 2): string {
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

/**
 * A gain of 0.17% on margin must not round to "0%", and one of 1,000% must not
 * carry two decimals, so the precision follows the magnitude.
 */
function gainPct(value: number): string {
  const magnitude = Math.abs(value);
  return pct(value, magnitude < 1 ? 2 : magnitude < 10 ? 1 : 0);
}

/**
 * Past the whole gain the figure stops being a share of anything, so it stops
 * pretending to be one: an 18,424.8% share is a venue taking 184 times the
 * gain, which is not a number a reader can repair on their own.
 */
function shareOfGainLabel(share: number): string {
  if (share <= 1) return pct(share * 100, 1);
  return `${share.toLocaleString("en-US", { maximumFractionDigits: 1 })}x the gain`;
}

// ── Input handling ────────────────────────────────────────────────────────

type NumberField = { raw: string; value: number; valid: boolean };

function readField(raw: string, min: number, max: number, fallback: number): NumberField {
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  const valid = trimmed !== "" && Number.isFinite(parsed) && parsed >= min && parsed <= max;
  return { raw, value: valid ? parsed : fallback, valid };
}

// ── Shared class strings ──────────────────────────────────────────────────

const LABEL = "block font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mb-1.5";
const TH =
  "px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right whitespace-nowrap";
const TD = "px-3 py-3 text-right font-mono text-xs text-ink-soft tabular-nums";

function numberInputClass(valid: boolean): string {
  return [
    "w-full rounded-xl border bg-paper px-3.5 py-2.5 font-mono text-sm tabular-nums",
    "focus:outline-none transition-colors",
    valid ? "border-ink/15 text-ink focus:border-ink/40" : "border-bad text-ink",
  ].join(" ");
}

// ── Component ─────────────────────────────────────────────────────────────

export function PerpCostClient() {
  const [marginRaw, setMarginRaw] = useState(String(MARGIN_RANGE.default));
  const [leverageRaw, setLeverageRaw] = useState(String(LEVERAGE_RANGE.default));
  const [moveSlider, setMoveSlider] = useState<number>(MOVE_RANGE.default);
  const [market, setMarket] = useState<Market>("BTC");

  const margin = readField(marginRaw, MARGIN_RANGE.min, MARGIN_RANGE.max, MARGIN_RANGE.default);
  const leverage = readField(
    leverageRaw,
    LEVERAGE_RANGE.min,
    LEVERAGE_RANGE.max,
    LEVERAGE_RANGE.default,
  );
  // The slider is in thousandths of a percent, so 200 is 0.200% of price.
  const move = moveSlider / 1000 / 100;

  const model = useMemo(
    () => computeCostModel({ margin: margin.value, leverage: leverage.value, market, move }),
    [margin.value, leverage.value, market, move],
  );

  const inputsValid = margin.valid && leverage.valid;
  const widestShare = Math.max(...model.live.map((r) => r.shareOfGain), 1e-4);

  return (
    <div className="space-y-6">
      {/* Controls */}
      <section className="rounded-2xl border border-rule bg-surface p-5 sm:p-6">
        <div className="grid gap-5 sm:grid-cols-3">
          <div>
            <label htmlFor="perp-cost-margin" className={LABEL}>
              Margin posted (USD)
            </label>
            <input
              id="perp-cost-margin"
              type="number"
              inputMode="decimal"
              min={MARGIN_RANGE.min}
              max={MARGIN_RANGE.max}
              step={100}
              value={marginRaw}
              aria-invalid={!margin.valid}
              onChange={(e) => setMarginRaw(e.target.value)}
              className={numberInputClass(margin.valid)}
            />
          </div>

          <div>
            <label htmlFor="perp-cost-leverage" className={LABEL}>
              Leverage
            </label>
            <input
              id="perp-cost-leverage"
              type="number"
              inputMode="numeric"
              min={LEVERAGE_RANGE.min}
              max={LEVERAGE_RANGE.max}
              step={1}
              value={leverageRaw}
              aria-invalid={!leverage.valid}
              onChange={(e) => setLeverageRaw(e.target.value)}
              className={numberInputClass(leverage.valid)}
            />
          </div>

          <div>
            <span className={LABEL} id="perp-cost-market-label">
              Market
            </span>
            <div
              role="group"
              aria-labelledby="perp-cost-market-label"
              className="flex rounded-xl border border-ink/15 bg-paper p-1"
            >
              {(["BTC", "ETH"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={market === m}
                  onClick={() => setMarket(m)}
                  className={`flex-1 rounded-lg py-1.5 font-mono text-xs transition-colors ${
                    market === m ? "bg-ink text-paper font-semibold" : "text-ink-faint hover:text-ink"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-5">
          <label htmlFor="perp-cost-move" className={LABEL}>
            Price move in your favour
          </label>
          <input
            id="perp-cost-move"
            type="range"
            min={MOVE_RANGE.min}
            max={MOVE_RANGE.max}
            step={1}
            value={moveSlider}
            aria-valuetext={`${pct(move * 100, 3)} of price`}
            onChange={(e) => setMoveSlider(Number(e.target.value))}
            className="w-full accent-accent"
          />
          <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2 font-mono text-xs text-ink-faint">
            <span>
              <strong className="font-mono text-base font-semibold text-ink">
                {pct(move * 100, 3)}
              </strong>{" "}
              of price
            </span>
            <span>
              = <strong className="font-semibold text-ink">+{gainPct((model.rawGain / model.margin) * 100)}</strong>{" "}
              on your margin
            </span>
          </div>
        </div>

        {!inputsValid && (
          <p role="status" className="mt-4 font-sans text-xs text-bad">
            That value is outside the accepted range (margin $1 to $1,000,000,000, leverage 1x to
            1000x), so every figure below is for {usd(model.margin)} at {model.leverage}x.
          </p>
        )}
      </section>

      {/* Summary */}
      <section
        aria-live="polite"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-rule bg-rule sm:grid-cols-4"
      >
        <SummaryCell
          label="Raw gain"
          value={usd(model.rawGain)}
          sub={`${gainPct((model.rawGain / model.margin) * 100)} of your margin`}
        />
        <SummaryCell
          label="Cheapest"
          value={model.cheapest ? model.cheapest.venue.name : "n/a"}
          sub={
            model.cheapest
              ? `${usd(model.cheapest.cost)} taken`
              : `no venue offers ${model.leverage}x`
          }
        />
        <SummaryCell
          label="Dearest"
          value={model.dearest ? model.dearest.venue.name : "n/a"}
          sub={model.dearest ? `${usd(model.dearest.cost)} taken` : "only one venue open"}
        />
        <SummaryCell
          label="Spread"
          value={
            model.dearest && model.cheapest ? usd(model.dearest.cost - model.cheapest.cost) : "n/a"
          }
          sub={model.dearest ? "between them, same trade" : "only one venue open"}
        />
      </section>

      {/* The winning path */}
      <section className="rounded-2xl border border-rule bg-surface">
        <header className="px-5 pt-5 sm:px-6">
          <p className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-faint">
            The winning path
          </p>
          <h2 className="display mt-1 text-xl text-ink">What each venue keeps from your gain</h2>
        </header>

        <div
          className="mt-4 overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Cost of a winning trade by venue"
        >
          <table className="w-full text-sm">
            <caption className="sr-only">
              Cost, net gain, share of the gain and room to liquidation, by venue
            </caption>
            <thead>
              <tr className="border-y border-rule">
                <th scope="col" className={`${TH} text-left`}>
                  <span className="sr-only">Rank</span>
                </th>
                <th scope="col" className={`${TH} text-left`}>
                  Venue
                </th>
                <th scope="col" className={TH}>
                  Cost
                </th>
                <th scope="col" className={TH}>
                  You net
                </th>
                <th scope="col" className={TH}>
                  Share of gain
                </th>
                <th scope="col" className={TH}>
                  Room to liq. (% of price)
                </th>
              </tr>
            </thead>
            <tbody>
              {model.live.map((row, i) => {
                const crowned = i === 0 && row.net > 0;
                return (
                  <tr
                    key={row.venue.id}
                    className={`border-b border-rule/60 ${crowned ? "bg-good/8" : ""}`}
                  >
                    <td className="px-3 py-3 font-mono text-[11px] text-ink-faint">{i + 1}</td>
                    <td className="px-3 py-3 text-left">
                      <VenueName row={row} />
                    </td>
                    <td className={TD}>{usd(row.cost)}</td>
                    <td
                      className={`${TD} font-semibold ${
                        row.net > 0 ? (crowned ? "text-good" : "text-ink") : "text-bad"
                      }`}
                    >
                      {usd(row.net)}
                    </td>
                    <td className={TD}>
                      <span className="inline-flex items-center justify-end gap-2">
                        {shareOfGainLabel(row.shareOfGain)}
                        <span
                          aria-hidden="true"
                          className="hidden h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-rule-strong sm:block"
                        >
                          <span
                            className={`block h-full rounded-full ${crowned ? "bg-good" : "bg-bad"}`}
                            style={{
                              width: `${Math.min(100, (row.shareOfGain / widestShare) * 100)}%`,
                            }}
                          />
                        </span>
                      </span>
                    </td>
                    <td className={TD}>
                      {row.roomPct === null ? "n/a" : pct(row.roomPct, row.roomPct < 1 ? 3 : 2)}{" "}
                      <span className="font-sans text-[9px] uppercase tracking-[0.1em] text-ink-faint">
                        {row.venue.src}
                      </span>
                    </td>
                  </tr>
                );
              })}

              {model.unavailable.map((row) => (
                <tr key={row.venue.id} className="border-b border-rule/60">
                  <td className="px-3 py-3 font-mono text-[11px] text-ink-faint">n/a</td>
                  <td className="px-3 py-3 text-left">
                    <VenueName row={row} muted />
                  </td>
                  <td colSpan={4} className="px-3 py-3 text-left font-mono text-xs text-ink-faint">
                    <span className="mr-2 rounded bg-bad/10 px-2 py-0.5 text-[11px] text-bad">
                      not offered at {model.leverage}x
                    </span>
                    {unavailableReason(row, model.leverage)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="px-5 py-5 text-sm leading-snug text-ink-soft sm:px-6">
          {!model.anyProfitable && model.cheapest && (
            <>
              <strong className="font-semibold text-ink">
                At this move no venue is profitable.
              </strong>{" "}
              The cheapest of them, {model.cheapest.venue.name}, still takes{" "}
              {usd(model.cheapest.cost)} out of a {usd(model.rawGain)} gain, so every row above is a
              loss and the ranking is only the order of the damage.{" "}
            </>
          )}

          {model.crossoverMove !== null && model.rival ? (
            <>
              <strong className="font-semibold text-ink">
                Against {model.rival.venue.name} {model.rival.venue.sub}, the cheapest
                notional-fee venue open at {model.leverage}x, the crossover sits at a{" "}
                {pct(model.crossoverMove * 100, 3)} move
              </strong>
              , a gain of{" "}
              {gainPct(((model.crossoverMove * model.notional) / model.margin) * 100)} on your
              margin. Below it Papertrade takes less; above it {model.rival.venue.name} does, and
              the gap widens from there. Against this one rival the leverage does not move the
              crossover, because it multiplies both costs equally. What leverage changes is which
              rival is open at all, and that moves the number a long way.
            </>
          ) : model.live.some((r) => r.venue.charges === "gain") ? (
            <>
              <strong className="font-semibold text-ink">
                Papertrade is the only venue open at {model.leverage}x
              </strong>
              , so there is nothing charging on notional to cross over against. The figure above is
              its haircut on the gain; drag the move and the share falls, but no ordering appears
              until a second venue opens.
            </>
          ) : (
            <>
              <strong className="font-semibold text-ink">
                No gain-based venue is open at {model.leverage}x
              </strong>
              , so every row charges a share of notional and the ranking is simply the cheapest fee
              plus half spread.
            </>
          )}
        </p>
      </section>

      {/* The other two paths */}
      <section className="rounded-2xl border border-rule bg-surface">
        <header className="px-5 pt-5 sm:px-6">
          <p className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-faint">
            The other two paths
          </p>
          <h2 className="display mt-1 text-xl text-ink">What happens when it does not work</h2>
        </header>

        <div
          className="mt-4 overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Cost of a flat trade and of a liquidation by venue"
        >
          <table className="w-full text-sm">
            <caption className="sr-only">
              What a flat close and a liquidation cost, by venue
            </caption>
            <thead>
              <tr className="border-y border-rule">
                <th scope="col" className={`${TH} text-left`}>
                  Venue
                </th>
                <th scope="col" className={`${TH} text-left`}>
                  Trade closes flat
                </th>
                <th scope="col" className={`${TH} text-left`}>
                  Trade is liquidated
                </th>
              </tr>
            </thead>
            <tbody>
              {model.live.map((row) => (
                <tr key={row.venue.id} className="border-b border-rule/60">
                  <td className="px-3 py-3 text-left">
                    <VenueName row={row} />
                  </td>
                  <td className="px-3 py-3 text-left font-mono text-xs text-ink-soft">
                    {row.flatCost === 0
                      ? "costs nothing"
                      : `${usd(row.flatCost)} of fees on a $0 gain`}
                  </td>
                  <td className="px-3 py-3 text-left font-mono text-xs text-ink-soft">
                    {row.equityLeftPct > 0 ? (
                      `${usd(row.equityLeftPct * model.margin)} of your ${usd(
                        model.margin,
                      )} left at the trigger`
                    ) : (
                      <span className="rounded bg-bad/10 px-2 py-0.5 text-[11px] text-bad">
                        nothing comes back
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="px-5 py-5 text-sm leading-snug text-ink-soft sm:px-6">
          Only the venues open at the chosen leverage appear here; the first table lists the others
          and why. The liquidation column is the equity the venue&apos;s own trigger leaves behind,{" "}
          <strong className="font-semibold text-ink">before</strong> the closing fee that trigger
          charges, and it is not a promise the money reaches you. On{" "}
          <strong className="font-semibold text-ink">Gains it does not</strong>: we paired every
          liquidation we could find and <code className="font-mono text-xs">amountSentToTrader</code>{" "}
          read zero on all 27, across every pair from 7.5x to 500x.{" "}
          <strong className="font-semibold text-ink">Papertrade&apos;s</strong> documentation calls
          its liquidation a hard bust that forfeits the full isolated margin. For the others this is
          the parameter, which we have not checked against a realised payout.
        </p>
      </section>
    </div>
  );
}

function SummaryCell({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-surface px-4 py-3.5">
      <p className="font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint">{label}</p>
      <p className="mt-0.5 break-words font-mono text-lg font-semibold tabular-nums text-ink">
        {value}
      </p>
      <p className="text-xs text-ink-faint">{sub}</p>
    </div>
  );
}

function VenueName({ row, muted = false }: { row: CostRow; muted?: boolean }) {
  return (
    <span className="block whitespace-nowrap">
      <span className={`font-sans text-sm font-medium ${muted ? "text-ink-faint" : "text-ink"}`}>
        {row.venue.name}
      </span>
      <span className="block font-mono text-[11px] text-ink-faint">{row.venue.sub}</span>
    </span>
  );
}
