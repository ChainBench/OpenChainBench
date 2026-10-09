"use client";

import { useState } from "react";
import { ProviderLogo } from "@/components/provider-logo";
import { hasLogo } from "@/lib/logo-manifest";
import {
  rpcCostCurves,
  rpcCostRankAt,
  type RpcCostRankedRow,
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

const COHORTS = [
  { value: "usage", label: "Billed per request" },
  { value: "dedicated", label: "Dedicated capacity" },
];

const STEPS = 1000;

/**
 * The panel opens where the board stands: the bench's headline workload is
 * the dapp mix (`kind=all` on the page) at 10M requests a month (`bucket=all`),
 * so the slider's first reading is one a reader can check against the ledger
 * directly above it rather than one they have to reconcile.
 */
const DEFAULT_PROFILE = "dapp";
const DEFAULT_REQUESTS = 10e6;

export function RpcCostSlider() {
  const file = rpcCostCurves();
  // The reader returns null when the artifact's schema is one this build does
  // not know. Rendering nothing is the honest outcome: `pnpm validate` fails
  // on that mismatch, and a slider quoting a shape it misread is worse than
  // no slider.
  const [profileId, setProfileId] = useState(() => {
    const ids = file?.profiles.map((p) => p.id) ?? [];
    return ids.includes(DEFAULT_PROFILE)
      ? DEFAULT_PROFILE
      : (ids[0] ?? "");
  });
  const [cohort, setCohort] = useState("usage");
  // The volume itself is the state, not the slider's position. Going through
  // the step would round-trip through a log scale and land 0.5% off: the
  // "100M" tick would read 99.5M and stop being one of the three volumes the
  // table publishes, which is the whole point of marking it.
  const [requests, setRequests] = useState(DEFAULT_REQUESTS);

  if (!file || file.profiles.length === 0) return null;

  const { floor, ceiling } = file;
  const { priced, unpriced } = rpcCostRankAt(profileId, requests);

  const inCohort = (r: RpcCostRankedRow) => r.cohort === cohort;
  const shown = priced.filter(inCohort);
  const missing = unpriced.filter(inCohort);
  const leader = shown[0];
  const onPublished = PUBLISHED.find((p) => p.requests === requests);

  return (
    <div className="mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="label-mono text-ink-faint">Price at your own volume</p>
          <p className="mt-1 text-sm text-ink-faint max-w-prose">
            The leaderboard prices three volumes, because a metric needs a
            fixed label. Move the slider to any volume between{" "}
            {fmtRequests(floor)} and {fmtRequests(ceiling)} requests a month.
            Same pricing model, read between the points it publishes.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {COHORTS.map((c) => (
            <Chip
              key={c.value}
              active={cohort === c.value}
              label={c.label}
              onClick={() => setCohort(c.value)}
            />
          ))}
        </div>
      </div>

      <div className="mt-6">
        <p className="label-mono text-ink-faint">Workload</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {file.profiles.map((p) => (
            <Chip
              key={p.id}
              active={profileId === p.id}
              label={p.label}
              onClick={() => setProfileId(p.id)}
            />
          ))}
        </div>
      </div>

      <div className="mt-6">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <p className="text-2xl font-semibold tabular-nums text-ink">
            {fmtRequests(requests)}
            <span className="ml-2 text-sm font-normal text-ink-muted">
              requests / month
            </span>
          </p>
          {leader ? (
            <p className="text-sm text-ink-muted">
              Cheapest:{" "}
              <span className="font-semibold text-ink">{leader.name}</span> at{" "}
              <span className="tabular-nums font-semibold text-ink">
                {fmtUSD(leader.usd)}
              </span>
              /mo
            </p>
          ) : (
            <p className="text-sm text-ink-muted">
              No provider in this cohort publishes a price at this volume.
            </p>
          )}
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

        {/* The three volumes the gauges publish, as buttons: they are where
            this panel and the ledger above can be checked against each
            other, so standing exactly on one has to be possible. */}
        <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-ink-faint">
          <span>{fmtRequests(floor)}</span>
          {PUBLISHED.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setRequests(p.requests)}
              className="underline decoration-dotted underline-offset-2 hover:text-ink transition-colors"
              title={`${p.label} requests a month, one of the three volumes the leaderboard publishes`}
            >
              {p.label}
            </button>
          ))}
          <span>{fmtRequests(ceiling)}</span>
        </div>

        <p className="mt-2 text-xs text-ink-faint">
          {onPublished
            ? `${onPublished.label} is one of the three volumes the leaderboard above publishes, so the two should agree here.`
            : "Between published volumes. Exact at every plan boundary, linear in between, which is the real shape of a metered bill."}
        </p>
      </div>

      {shown.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="border-y-2 border-ink py-2 pr-3 text-left font-medium label-mono text-ink-faint">
                  Provider
                </th>
                <th className="border-y-2 border-ink py-2 px-2 text-right font-medium label-mono text-ink-faint">
                  Monthly bill
                </th>
                <th className="border-y-2 border-ink py-2 px-2 text-right font-medium label-mono text-ink-faint whitespace-nowrap">
                  Per 1M
                </th>
                <th className="border-y-2 border-ink py-2 pl-2 text-left font-medium label-mono text-ink-faint">
                  Plan
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row, i) => (
                <tr key={row.slug} className="border-b border-ink/10">
                  <td className="py-2 pr-3">
                    <span className="inline-flex items-center gap-2">
                      <span className="tabular-nums text-ink-faint text-xs">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {hasLogo(row.slug) && (
                        <ProviderLogo slug={row.slug} name={row.name} size={16} />
                      )}
                      <span className="font-medium">{row.name}</span>
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums font-semibold">
                    {fmtUSD(row.usd)}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums text-ink-muted">
                    {fmtUSD(perMillion(row.usd, requests))}
                  </td>
                  <td className="py-2 pl-2 text-ink-muted">{row.plan || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Kept, and kept behind the priced rows. "Helius publishes no Ethereum
          plan" is an answer a reader moving the slider wants; a missing price
          sorted in among the real ones as $0 is the bug this bench shipped
          once already. */}
      {missing.length > 0 && (
        <details className="mt-5">
          <summary className="cursor-pointer text-xs uppercase tracking-[0.16em] text-ink-faint hover:text-ink transition-colors">
            {missing.length} provider{missing.length === 1 ? "" : "s"} quote
            nothing at {fmtRequests(requests)}
          </summary>
          <ul className="mt-3 space-y-1.5 text-sm">
            {missing.map((row) => (
              <li key={row.slug} className="flex flex-wrap gap-x-2 text-ink-muted">
                <span className="font-medium text-ink">{row.name}</span>
                <span>{row.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="mt-5 text-[11px] text-ink-faint">
        From the pricing catalogue as of {file.catalogueAsOf}, priced by the
        same harness that publishes the leaderboard. A blank is a provider with
        no plan for this volume, never a free one.
      </p>
    </div>
  );
}

function Chip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  const base =
    "px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] rounded-md transition-colors";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? `${base} bg-ink text-paper shadow-sm`
          : `${base} border border-rule text-ink-muted hover:text-ink hover:bg-paper-soft`
      }
    >
      {label}
    </button>
  );
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
    return `$${usd.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

function perMillion(usd: number | null, requests: number): number | null {
  if (usd === null || requests <= 0) return null;
  return (usd / requests) * 1e6;
}
