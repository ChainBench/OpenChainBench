"use client";

import { useState } from "react";
import { ProviderLogo } from "@/components/provider-logo";
import { hasLogo } from "@/lib/logo-manifest";
import {
  rpcCostCurves,
  rpcCostRankAt,
} from "@/lib/rpc-cost-curve";

/**
 * "What would I actually pay?" for bench 282, at any volume rather than the
 * three the gauges publish.
 *
 * A Prometheus series needs a fixed label, so the leaderboard prices 10M,
 * 100M and 1B requests a month. Most readers are somewhere else. This reads
 * the committed curve (src/data/rpc-cost-curves.json, emitted by the same
 * harness through the same cheapest() the gauges go through) and interpolates
 * between its points, which is exact rather than smoothed: inside one plan
 * and one overage band the bill is affine in the request count.
 *
 * The three published volumes are marked on the track on purpose. They are
 * the points where this panel and the ledger above it can be checked against
 * each other, and a reader who wants to verify the slider should be able to
 * see where to stand.
 *
 * No props: the JSON is imported, so Next ships it as part of this page's
 * client chunk instead of inlining 158 KB into the document on every ISR
 * revalidation.
 */

/** The volumes the gauges publish, which are the ones a reader can cross-check. */
const PUBLISHED = [
  { requests: 10e6, label: "10M" },
  { requests: 100e6, label: "100M" },
  { requests: 1000e6, label: "1B" },
];

const STEPS = 1000;

/**
 * Two curves, one checkbox. Both are the dapp mix (contract reads, balances,
 * receipts, a 5% tail of getLogs and writes); the archive one prices every
 * call as reading state old enough to bill as archive, which is where
 * Chainstack's 2 RU block-age rule bites and Dwellir's flat 1 credit does
 * not, and where plans without archive drop out. The other workloads stay on
 * the ledger's methodology; a reader asking "what do I pay" wants one answer,
 * and four rows of selectors in front of it was the complaint.
 */
const PROFILE = "dapp";
const PROFILE_ARCHIVE = "dapp-archive";
const DEFAULT_REQUESTS = 10e6;
const SHOWN = 10;

export function RpcCostSlider() {
  const file = rpcCostCurves();
  const [archive, setArchive] = useState(false);
  // The volume itself is the state, not the slider's position. Going through
  // the step would round-trip through a log scale and land 0.5% off: the
  // "100M" tick would read 99.5M and stop being one of the three volumes the
  // ledger publishes.
  const [requests, setRequests] = useState(DEFAULT_REQUESTS);
  const [showAll, setShowAll] = useState(false);

  // The reader returns null when the artifact's schema is one this build does
  // not know. Rendering nothing is the honest outcome: `pnpm validate` fails
  // on that mismatch, and a slider quoting a shape it misread is worse than
  // no slider.
  if (!file || file.profiles.length === 0) return null;

  const { floor, ceiling } = file;
  // Both cohorts in one list: past a few hundred million requests a flat-rate
  // node beats every meter, and "what is the best plan at my volume" has to
  // be allowed to say so.
  const { priced, unpriced } = rpcCostRankAt(
    archive ? PROFILE_ARCHIVE : PROFILE,
    requests,
  );
  const leader = priced[0];
  const rest = priced.slice(1);
  const visible = showAll ? rest : rest.slice(0, SHOWN - 1);
  const onPublished = PUBLISHED.find((p) => p.requests === requests);

  return (
    <section
      id="calculator"
      className="mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8"
      aria-label="RPC cost calculator"
    >
      <h2 className="label-mono text-ink">Cheapest RPC plan for your volume</h2>
      <p className="mt-1 text-sm text-ink-faint max-w-prose">
        Slide to your monthly request count on Ethereum. Every provider&apos;s
        published plans are priced on a typical dapp mix, and the cheapest plan
        that serves it wins, metered or flat rate.
      </p>

      <div className="mt-6 flex items-baseline justify-between gap-3 flex-wrap">
        <p className="text-3xl font-semibold tabular-nums text-ink">
          {fmtRequests(requests)}
          <span className="ml-2 text-sm font-normal text-ink-muted">
            requests / month
          </span>
        </p>
        <label className="inline-flex items-center gap-2 text-sm text-ink cursor-pointer select-none">
          <input
            type="checkbox"
            checked={archive}
            onChange={(e) => setArchive(e.target.checked)}
            className="h-4 w-4 accent-ink"
          />
          I need archive data
        </label>
      </div>

      <input
        type="range"
        min={0}
        max={STEPS}
        step={1}
        value={stepOf(requests, floor, ceiling)}
        onChange={(e) =>
          setRequests(
            roundRequests(requestsAt(Number(e.target.value), floor, ceiling)),
          )
        }
        aria-label="Monthly request volume"
        aria-valuetext={`${fmtRequests(requests)} requests per month`}
        className="mt-3 w-full accent-ink"
      />

      {/* The three volumes the ledger publishes, as buttons: standing exactly
          on one has to be possible for the two surfaces to be checkable
          against each other. */}
      <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-ink-faint">
        <span>{fmtRequests(floor)}</span>
        {PUBLISHED.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => setRequests(p.requests)}
            className="underline decoration-dotted underline-offset-2 hover:text-ink transition-colors"
          >
            {p.label}
          </button>
        ))}
        <span>{fmtRequests(ceiling)}</span>
      </div>

      <p className="mt-2 text-xs text-ink-faint">
        {archive
          ? "Archive: every call reads state older than the last ~128 blocks. Plans without archive drop out, and providers that bill archive higher (Chainstack 2 RU instead of 1) are priced at that rate."
          : "No archive: calls read recent state only."}
      </p>

      {leader ? (
        <div className="mt-6 rounded-lg border-2 border-ink p-4 sm:p-5">
          <p className="label-mono text-ink-faint">Best plan</p>
          <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
            <span className="inline-flex items-center gap-3">
              {hasLogo(leader.slug) && (
                <ProviderLogo slug={leader.slug} name={leader.name} size={28} />
              )}
              <span>
                <span className="block text-xl font-semibold text-ink">
                  {brandOf(leader.name)}
                </span>
                <span className="block text-sm text-ink-muted">
                  {leader.planName || planLabel(leader.plan)}
                  {leader.cohort === "dedicated" ? " · flat rate" : ""}
                </span>
              </span>
            </span>
            <span className="text-right">
              <span className="block text-3xl font-semibold tabular-nums text-ink">
                {fmtUSD(leader.usd)}
                <span className="text-sm font-normal text-ink-muted">/mo</span>
              </span>
              <span className="block text-xs tabular-nums text-ink-faint">
                {fmtUSD(perMillion(leader.usd, requests))} per 1M requests
              </span>
            </span>
          </div>
        </div>
      ) : (
        <p className="mt-6 text-sm text-ink-muted">
          No provider publishes a plan for this volume.
        </p>
      )}

      {visible.length > 0 && (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {visible.map((row, i) => (
                <tr key={row.slug} className="border-b border-ink/10">
                  <td className="py-2 pr-3">
                    <span className="inline-flex items-center gap-2">
                      <span className="tabular-nums text-ink-faint text-xs">
                        {String(i + 2).padStart(2, "0")}
                      </span>
                      {hasLogo(row.slug) && (
                        <ProviderLogo slug={row.slug} name={row.name} size={16} />
                      )}
                      <span className="font-medium">{brandOf(row.name)}</span>
                    </span>
                  </td>
                  <td className="py-2 px-2 text-ink-muted">
                    {row.planName || planLabel(row.plan)}
                    {row.cohort === "dedicated" ? " · flat rate" : ""}
                  </td>
                  <td className="py-2 pl-2 text-right tabular-nums font-semibold whitespace-nowrap">
                    {fmtUSD(row.usd)}
                    <span className="font-normal text-ink-faint">/mo</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rest.length > SHOWN - 1 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-3 text-xs uppercase tracking-[0.16em] text-ink-faint hover:text-ink transition-colors"
            >
              {showAll ? "Show fewer" : `Show all ${priced.length} plans`}
            </button>
          )}
        </div>
      )}

      {/* Kept, and kept behind the priced rows. "Helius publishes no Ethereum
          plan" is an answer a reader moving the slider wants; a missing price
          sorted in among the real ones as $0 is the bug this bench shipped
          once already. */}
      {unpriced.length > 0 && (
        <details className="mt-5">
          <summary className="cursor-pointer text-xs uppercase tracking-[0.16em] text-ink-faint hover:text-ink transition-colors">
            {unpriced.length} provider{unpriced.length === 1 ? "" : "s"} quote
            nothing at {fmtRequests(requests)}
          </summary>
          <ul className="mt-3 space-y-1.5 text-sm">
            {unpriced.map((row) => (
              <li key={row.slug} className="flex flex-wrap gap-x-2 text-ink-muted">
                <span className="font-medium text-ink">{row.name}</span>
                <span>{row.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="mt-5 text-[11px] text-ink-faint">
        {onPublished
          ? `${onPublished.label} is one of the three volumes the findings below quote, so the two agree here. `
          : "Exact at every plan boundary, linear in between, which is the real shape of a metered bill. "}
        Pricing catalogue as of {file.catalogueAsOf}. A free plan wins when it
        covers the volume; a blank is a provider with no plan for it, never a
        free one.
      </p>
    </section>
  );
}

/**
 * The flat-rate rows carry their offer in the name ("GetBlock — Dedicated &
 * Limitless nodes"); the plan column already says what was bought, so the
 * row leads with the brand.
 */
export function brandOf(name: string): string {
  return name.split(/ — |, /)[0] ?? name;
}

/** Plan ids are kebab slugs from the catalogue: "dedicated-eth-archive". */
export function planLabel(plan: string): string {
  if (!plan) return "-";
  const s = plan.replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The track is logarithmic. 100k to 5B is four and a half decades, and a
 * linear track would spend 98% of its length above 100M, where the readings
 * barely move, and crowd every entry plan into the first two pixels.
 */
export function requestsAt(step: number, floor: number, ceiling: number): number {
  const t = Math.min(1, Math.max(0, step / STEPS));
  return floor * Math.pow(ceiling / floor, t);
}

export function stepOf(requests: number, floor: number, ceiling: number): number {
  const t = Math.log(requests / floor) / Math.log(ceiling / floor);
  return Math.round(Math.min(1, Math.max(0, t)) * STEPS);
}

/** Three significant figures: nobody is budgeting for 41,237,905 requests. */
export function roundRequests(r: number): number {
  if (!Number.isFinite(r) || r <= 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(r)) - 2);
  return Math.round(r / mag) * mag;
}

export function fmtRequests(r: number): string {
  if (r >= 1e9) return `${trim(r / 1e9)}B`;
  if (r >= 1e6) return `${trim(r / 1e6)}M`;
  if (r >= 1e3) return `${trim(r / 1e3)}k`;
  return String(Math.round(r));
}

function trim(v: number): string {
  return v
    .toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1");
}

export function fmtUSD(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd)) return "-";
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 100)
    return `$${usd.toFixed(2).replace(/\.00$/, "")}`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

function perMillion(usd: number | null, requests: number): number | null {
  if (usd === null || requests <= 0) return null;
  return (usd / requests) * 1e6;
}
