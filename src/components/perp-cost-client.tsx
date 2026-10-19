"use client";

import { useMemo, useState } from "react";
import { PerpCostChart, seriesColor } from "@/components/perp-cost-chart";
import { ProviderLogo } from "@/components/provider-logo";
import { getProviderRegistry, safeRegistryURL } from "@/data/provider-registry";
import {
  type CostRow,
  computeCostModel,
  feeLegFraction,
  LEVERAGE_RANGE,
  type Market,
  MARGIN_RANGE,
  MOVE_RANGE,
  unavailableReason,
  venueLabel,
} from "@/lib/perp-cost-model";
import { withUtm } from "@/lib/utm";

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

function bps(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ── Input handling ────────────────────────────────────────────────────────

type NumberField = { value: number; valid: boolean };

function readField(raw: string, min: number, max: number, fallback: number): NumberField {
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  const valid = trimmed !== "" && Number.isFinite(parsed) && parsed >= min && parsed <= max;
  return { value: valid ? parsed : fallback, valid };
}

/**
 * The leverages where something actually changes: each is a venue's cap, its
 * minimum, or the only leverage one product trades at. Typing 500 to discover
 * that the x500 degen pair exists is not discoverable, a chip is.
 */
const LEVERAGE_PICKS = [1, 10, 25, 40, 50, 100, 200, 500, 1000];

// ── Shared class strings ──────────────────────────────────────────────────

const LABEL = "block font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mb-1.5";
const TH =
  "px-3 py-2.5 font-sans text-[10px] uppercase tracking-[0.12em] text-ink-faint font-medium text-right whitespace-nowrap";
const TD = "px-3 py-3 text-right font-mono text-xs tabular-nums text-ink-soft";
const TAG =
  "inline-block rounded border border-rule px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint";

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
  const runnerUp = model.live[1] ?? null;

  return (
    <div className="space-y-5">
      {/* ── Controls ────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-rule bg-surface p-5 sm:p-6">
        <div className="grid gap-5 sm:grid-cols-[1fr_1fr_auto]">
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
              className="flex gap-1 rounded-xl border border-ink/15 bg-paper p-1"
            >
              {(["BTC", "ETH"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={market === m}
                  onClick={() => setMarket(m)}
                  className={`rounded-lg px-4 py-1.5 font-mono text-xs transition-colors ${
                    market === m
                      ? "bg-ink text-paper font-semibold"
                      : "text-ink-faint hover:text-ink"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            Jump to
          </span>
          {LEVERAGE_PICKS.map((lev) => (
            <button
              key={lev}
              type="button"
              aria-pressed={leverage.valid && leverage.value === lev}
              onClick={() => setLeverageRaw(String(lev))}
              className={`rounded-lg border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                leverage.valid && leverage.value === lev
                  ? "border-accent bg-accent text-white"
                  : "border-rule text-ink-faint hover:border-rule-strong hover:text-ink"
              }`}
            >
              {lev}x
            </button>
          ))}
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
              of {market} price
            </span>
            <span>
              ={" "}
              <strong className="font-semibold text-ink">
                +{gainPct((model.rawGain / model.margin) * 100)}
              </strong>{" "}
              on your margin, {usd(model.rawGain)} on {usd(model.notional)} of notional
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

      {/* ── Verdict ─────────────────────────────────────────────────── */}
      <section
        aria-live="polite"
        className="overflow-hidden rounded-2xl border border-rule bg-surface"
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4 p-5 sm:p-6">
          {model.cheapest ? (
            <>
              <div className="flex items-center gap-3">
                <ProviderLogo
                  slug={model.cheapest.venue.logoKey}
                  name={model.cheapest.venue.name}
                  size={40}
                />
                <div>
                  <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                    {model.anyProfitable ? "Cheapest on this trade" : "Least bad on this trade"}
                  </p>
                  {/* Name alone on the headline line: "Papertrade charges on
                      the gain" at display size read as a sentence, not a name. */}
                  <p className="display text-xl leading-tight text-ink">
                    {model.cheapest.venue.name}
                  </p>
                  <p className="font-mono text-[11px] text-ink-faint">
                    {model.cheapest.venue.sub || model.cheapest.venue.execution} ·{" "}
                    {model.cheapest.venue.chain}
                  </p>
                </div>
              </div>

              <dl className="flex flex-wrap gap-x-6 gap-y-3">
                <Figure
                  k="It takes"
                  v={usd(model.cheapest.cost)}
                  s={`${shareOfGainLabel(model.cheapest.shareOfGain)} of the gain`}
                />
                <Figure
                  k="You keep"
                  v={usd(model.cheapest.net)}
                  s={`${gainPct((model.cheapest.net / model.margin) * 100)} on your margin`}
                  tone={model.cheapest.net > 0 ? "good" : "bad"}
                />
                {runnerUp && (
                  <Figure
                    k="Versus next"
                    v={usd(runnerUp.cost - model.cheapest.cost)}
                    s={`cheaper than ${venueLabel(runnerUp.venue)}`}
                  />
                )}
                <Figure
                  k="Open here"
                  v={`${model.live.length} of ${model.live.length + model.unavailable.length}`}
                  s={`products at ${model.leverage}x`}
                />
              </dl>
            </>
          ) : (
            <p className="text-sm text-ink-soft">
              No venue in this set offers {model.leverage}x on {market}. The table below says what
              each one caps at.
            </p>
          )}
        </div>

        {!model.anyProfitable && model.cheapest && (
          <p className="border-t border-rule bg-bad/5 px-5 py-3 text-sm text-ink-soft sm:px-6">
            <strong className="font-semibold text-ink">At this move nothing is profitable.</strong>{" "}
            The fees exceed the gain on every open venue, so the ranking below is the order of the
            damage and not a recommendation.
          </p>
        )}
      </section>

      {/* ── Chart ───────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-rule bg-surface p-5 sm:p-6">
        <p className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-faint">
          Why the order flips
        </p>
        {/* Not "a fee on the gain is a curve": a constant share of the gain
            draws a line through the origin, same as a flat fee draws a level
            one. It is the rate climbing with the move that bends it. */}
        <h2 className="display mt-1 text-xl text-ink">
          A flat fee is a line, a rate that climbs is a curve
        </h2>
        <div className="mt-4 overflow-x-auto">
          <div className="min-w-[560px]">
            <PerpCostChart model={model} market={market} />
          </div>
        </div>

        {/* The legend doubles as the chart's data: a reader who cannot see the
            lines still gets every series, its colour and its cost here. */}
        <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-rule pt-3">
          {model.live.map((row, i) => (
            <li key={row.venue.id} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-0.5 w-4 shrink-0 rounded"
                style={{
                  background: seriesColor(
                    row.venue.logoKey,
                    row.venue.charges === "gain" ? 0 : i + 1,
                  ),
                }}
              />
              <ProviderLogo slug={row.venue.logoKey} name={row.venue.name} size={18} />
              <span className="font-sans text-xs text-ink-soft">
                {row.venue.name}
                {row.venue.sub && (
                  <span className="ml-1 font-mono text-[11px] text-ink-faint">
                    {row.venue.sub}
                  </span>
                )}
                <span className="ml-1.5 font-mono tabular-nums text-ink">{usd(row.cost)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ── The winning path ────────────────────────────────────────── */}
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
                <th scope="col" className={`${TH} hidden md:table-cell`}>
                  Taker + half spread
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
                  Room to liq.
                </th>
              </tr>
            </thead>
            <tbody>
              {model.live.map((row, i) => {
                const crowned = i === 0 && row.net > 0;
                const leg = feeLegFraction(row.venue, market) * 1e4;
                return (
                  <tr
                    key={row.venue.id}
                    className={`border-b border-rule/60 ${crowned ? "bg-good/8" : ""}`}
                  >
                    <td className="px-3 py-3 font-mono text-[11px] text-ink-faint">{i + 1}</td>
                    <td className="px-3 py-3 text-left">
                      <VenueCell row={row} />
                    </td>
                    <td className={`${TD} hidden md:table-cell`}>
                      {row.venue.charges === "gain" ? (
                        <span className="text-ink-faint">no fee, no spread</span>
                      ) : (
                        <>
                          {bps(row.venue.takerBps)} + {bps(row.venue.spreadBps[market] / 2)} bps
                          <span className="block text-[10px] text-ink-faint">
                            {bps(leg)} bps a leg
                          </span>
                        </>
                      )}
                    </td>
                    <td className={`${TD} text-ink`}>{usd(row.cost)}</td>
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
                            className={`block h-full rounded-full ${
                              crowned ? "bg-good" : "bg-bad"
                            }`}
                            style={{
                              width: `${Math.min(100, (row.shareOfGain / widestShare) * 100)}%`,
                            }}
                          />
                        </span>
                      </span>
                    </td>
                    <td className={TD}>
                      {row.roomPct === null ? "n/a" : pct(row.roomPct, row.roomPct < 1 ? 3 : 2)}
                      <span className="block whitespace-nowrap text-[10px] text-ink-faint">
                        of price · {row.venue.src}
                      </span>
                    </td>
                  </tr>
                );
              })}

              {model.unavailable.map((row) => (
                <tr key={row.venue.id} className="border-b border-rule/60">
                  <td className="px-3 py-3 font-mono text-[11px] text-ink-faint">n/a</td>
                  <td className="px-3 py-3 text-left">
                    <VenueCell row={row} muted />
                  </td>
                  {/* Not a failure, just a product that does not trade here, so
                      this reads neutral: eight red pills made the default view
                      look like an error state. */}
                  <td colSpan={5} className="px-3 py-3 text-left font-mono text-xs text-ink-faint">
                    <span className="mr-2 rounded border border-rule px-2 py-0.5 text-[11px]">
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
          {model.crossoverMove !== null && model.rival ? (
            <>
              <strong className="font-semibold text-ink">
                Against {venueLabel(model.rival.venue)}, the cheapest notional-fee venue open at{" "}
                {model.leverage}x, the crossover sits at a {pct(model.crossoverMove * 100, 3)} move
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

      {/* ── The other two paths ─────────────────────────────────────── */}
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
                    <VenueCell row={row} compact />
                  </td>
                  <td className="px-3 py-3 text-left font-mono text-xs text-ink-soft">
                    {row.flatCost === 0 ? (
                      <span className="text-good">costs nothing</span>
                    ) : (
                      `${usd(row.flatCost)} of fees on a $0 gain`
                    )}
                  </td>
                  <td className="px-3 py-3 text-left font-mono text-xs text-ink-soft">
                    {row.equityLeftPct > 0 ? (
                      <>
                        {usd(row.equityLeftPct * model.margin)} left of {usd(model.margin)}
                        <span className="block text-[10px] text-ink-faint">
                          {pct(row.equityLeftPct * 100, 1)} of your margin, before the closing fee
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="rounded bg-bad/10 px-2 py-0.5 text-[11px] text-bad">
                          nothing comes back
                        </span>
                        {/* Still "nothing comes back": no margin returns, and
                            the token cannot be sold at launch. But a venue
                            that mints to the loser is not the same as one that
                            keeps everything, so the row says so. */}
                        {row.venue.mintsOnLoss ? (
                          <span className="mt-1 block text-[10px] text-ink-faint">
                            {row.venue.mintsOnLoss}
                          </span>
                        ) : null}
                      </>
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
          liquidation we could find and{" "}
          <code className="font-mono text-xs">amountSentToTrader</code> read zero on all 27, across
          every pair from 7.5x to 500x.{" "}
          <strong className="font-semibold text-ink">Papertrade&apos;s</strong> documentation calls
          its liquidation a hard bust that forfeits the full isolated margin. For the others this is
          the parameter, which we have not checked against a realised payout.
        </p>

        <p className="mt-3 text-[13px] leading-relaxed text-ink-faint">
          One thing does come back on{" "}
          <strong className="font-semibold text-ink">Papertrade</strong>, and it is not margin.
          Losing is the only event that mints its token: the docs state that{" "}
          <em>PAPER mints to your account whenever you close a trade at a loss or get liquidated,
          and nothing else mints PAPER</em>. The rate is published in full. Below $2M of tracked LP
          it is a flat 100 PAPER per dollar of mint basis; at or above it the rate is{" "}
          <code className="font-mono text-xs">100 × (S ÷ (S + H))²</code>, where S is the $120M
          decay scale and H a high-water-mark of cumulative LP gain past the threshold that never
          falls back. H is not published as a field, so it is read off the peak of the
          venue&apos;s own daily tracked-LP series, $104.89M, which puts the rate near{" "}
          <strong className="font-semibold text-ink">29 PAPER per dollar of loss</strong>; the
          venue&apos;s own worked example, 29.8 at a $100M high-water-mark, lands beside it. Because
          H only ratchets upward, that rate falls for later traders and never recovers. A
          liquidation mints on the full lost margin; an ordinary losing close mints on the loss
          after the 2% fee, which is carved from the LP&apos;s side rather than added to the loss.
          Two things stop any of it being a rebate: at launch PAPER cannot be transferred, only
          staked and unstaked, and what staking pays is a pro-rata share of future protocol revenue
          that dilutes as later losers mint more. The row says both that no margin returns and that
          something is minted, because either sentence alone is misleading.
        </p>
      </section>
    </div>
  );
}

function Figure({
  k,
  v,
  s,
  tone,
}: {
  k: string;
  v: string;
  s: string;
  tone?: "good" | "bad";
}) {
  return (
    <div>
      <dt className="font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint">{k}</dt>
      <dd
        className={`font-mono text-lg font-semibold tabular-nums ${
          tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-ink"
        }`}
      >
        {v}
      </dd>
      <dd className="text-xs text-ink-faint">{s}</dd>
    </div>
  );
}

/**
 * Logo, name, what sets this product apart, and where it trades. `compact`
 * drops the chain and execution tags for the second table, which lists the
 * same venues a screen below and does not need to repeat them.
 */
function VenueCell({
  row,
  muted = false,
  compact = false,
}: {
  row: CostRow;
  muted?: boolean;
  compact?: boolean;
}) {
  const { venue } = row;
  const site = safeRegistryURL(getProviderRegistry(venue.logoKey)?.url);
  return (
    <div className={`flex items-center gap-2.5 ${muted ? "opacity-70" : ""}`}>
      <ProviderLogo slug={venue.logoKey} name={venue.name} size={compact ? 22 : 26} />
      <div className="min-w-0">
        <p className="whitespace-nowrap font-sans text-sm font-medium text-ink">
          {site ? (
            <a
              href={withUtm(site)}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {venue.name}
            </a>
          ) : (
            venue.name
          )}
          {venue.sub && (
            <span className="ml-1.5 font-mono text-[11px] font-normal text-ink-faint">
              {venue.sub}
            </span>
          )}
        </p>
        {!compact && (
          <p className="mt-0.5 flex flex-wrap items-center gap-1">
            <span className={TAG}>{venue.chain}</span>
            <span className={TAG}>{venue.execution}</span>
          </p>
        )}
      </div>
    </div>
  );
}
