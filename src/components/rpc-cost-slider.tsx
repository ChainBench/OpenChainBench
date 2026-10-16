"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import { hasLogo } from "@/lib/logo-manifest";
import {
  rpcCostCurves,
  rpcCostRankAt,
  type RpcCostRankedRow,
} from "@/lib/rpc-cost-curve";

/**
 * Bench 282's calculator, and since 2026-10-16 the page's main surface: one
 * volume slider and one archive switch answer "which plan do I buy".
 *
 * It reads the committed curve (src/data/rpc-cost-curves.json, emitted by the
 * same harness through the same cheapest() the gauges go through) and
 * interpolates between its points, which is exact rather than smoothed:
 * inside one plan and one overage band the bill is affine in the request
 * count.
 *
 * No props: the JSON is imported, so Next ships it as part of this page's
 * client chunk instead of inlining it into the document on every ISR
 * revalidation.
 */

/** The volumes the findings quote, which are the ones a reader can cross-check. */
const PUBLISHED = [
  { requests: 10e6, label: "10M" },
  { requests: 100e6, label: "100M" },
  { requests: 1000e6, label: "1B" },
];

const STEPS = 1000;

/**
 * Two curves, one switch. Both are the dapp mix (contract reads, balances,
 * receipts, a 5% tail of getLogs and writes); the archive one prices every
 * call as reading state old enough to bill as archive, which is where
 * Chainstack's 2 RU block-age rule bites and Dwellir's flat 1 credit does
 * not, and where plans without archive drop out.
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
  // "100M" tick would read 99.5M and stop being one of the published volumes.
  const [requests, setRequests] = useState(DEFAULT_REQUESTS);
  const [showAll, setShowAll] = useState(false);

  const profileId = archive ? PROFILE_ARCHIVE : PROFILE;
  const { priced, unpriced } = useMemo(
    () => rpcCostRankAt(profileId, requests),
    [profileId, requests],
  );

  // The reader returns null when the artifact's schema is one this build does
  // not know. Rendering nothing is the honest outcome: `pnpm validate` fails
  // on that mismatch, and a calculator quoting a shape it misread is worse
  // than none.
  if (!file || file.profiles.length === 0) return null;

  const { floor, ceiling } = file;
  // The leader slot takes the cheapest VERIFIED price. An uncertain one
  // (Zeeve publishes no throughput, Dwellir Unlimited has an unpriced
  // premium add-on) stays in the list with a badge and is named on the card
  // as cheaper-but-unverified, so the headline answer never rests on a
  // figure the catalogue itself doubts (audit 2026-10-16).
  const leader = priced.find((r) => r.verified) ?? priced[0];
  const cheaperUnverified = leader
    ? priced.filter((r) => !r.verified && (r.usd ?? 0) < (leader.usd ?? 0))
    : [];
  const rest = priced.filter((r) => r !== leader);
  const podium = rest.slice(0, 3);
  const tail = rest.slice(3);
  const visibleTail = showAll ? tail : tail.slice(0, SHOWN);
  const onPublished = PUBLISHED.find((p) => p.requests === requests);
  const rps = requests / (30 * 86400);
  const dearest = priced.at(-1)?.usd ?? null;

  return (
    <section
      id="calculator"
      className="mt-8 overflow-hidden rounded-2xl border border-rule bg-surface shadow-sm"
      aria-label="RPC cost calculator"
    >
      {/* Controls */}
      <div className="border-b border-rule bg-paper-soft/70 p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-prose">
            <p className="label-mono text-accent">Calculator</p>
            <h2 className="mt-1 text-2xl sm:text-3xl font-semibold tracking-tight text-ink">
              Which RPC plan is cheapest at your volume?
            </h2>
            <p className="mt-1.5 text-sm text-ink-muted">
              Ethereum, a typical dapp mix. Every provider&apos;s published paid
              plans, billed per request or flat rate, priced for the month.
            </p>
          </div>
          <ArchiveSwitch archive={archive} onChange={setArchive} />
        </div>

        <div className="mt-7 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-5xl sm:text-6xl font-semibold tabular-nums tracking-tight text-ink">
            {fmtRequests(requests)}
          </p>
          <p className="text-sm text-ink-muted">
            requests a month
            <span className="text-ink-faint"> · about {fmtRate(rps)} per second</span>
          </p>
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
          className="mt-5 w-full cursor-pointer accent-[var(--color-accent)]"
        />
        {/* The three volumes the grid below prices, as buttons: standing
            exactly on one has to be possible for the two to be checkable
            against each other. */}
        <div className="relative mt-1 h-6 text-[11px] tabular-nums text-ink-faint">
          <span className="absolute left-0 top-1">{fmtRequests(floor)}</span>
          {PUBLISHED.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setRequests(p.requests)}
              style={{ left: `${((stepOf(p.requests, floor, ceiling) / STEPS) * 100).toFixed(1)}%` }}
              className={`absolute top-0 -translate-x-1/2 rounded-full border px-2 py-0.5 transition-colors ${
                requests === p.requests
                  ? "border-ink bg-ink text-paper"
                  : "border-rule bg-paper hover:border-rule-strong hover:text-ink"
              }`}
            >
              {p.label}
            </button>
          ))}
          <span className="absolute right-0 top-1">{fmtRequests(ceiling)}</span>
        </div>
        <p className="mt-3 text-xs text-ink-faint">
          {archive
            ? "Archive: every call reads state older than the last ~128 blocks. Plans without archive drop out; Chainstack bills 2 RU instead of 1 there."
            : "Recent state only: no call reads deeper than the last ~128 blocks."}
        </p>
      </div>

      {/* Answer */}
      <div className="p-5 sm:p-7">
        {leader ? (
          <BestPlanCard
            leader={leader}
            next={rest.find((r) => r.verified)}
            cheaperUnverified={cheaperUnverified[0]}
            requests={requests}
            plans={priced.length}
            dearest={dearest}
          />
        ) : (
          <div className="rounded-xl border border-rule p-5 text-sm text-ink-muted">
            No provider publishes a plan for this volume.
          </div>
        )}

        {podium.length > 0 && leader && (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {podium.map((row, i) => (
              <PodiumCard
                key={row.slug + row.plan}
                row={row}
                rank={i + 2}
                leaderUSD={leader.usd ?? 0}
              />
            ))}
          </div>
        )}

        {visibleTail.length > 0 && leader && (
          <div className="mt-6">
            <p className="label-mono text-ink-faint">
              Every other plan at {fmtRequests(requests)}
            </p>
            <ol className="mt-2 divide-y divide-rule">
              {visibleTail.map((row, i) => (
                <RankRow
                  key={row.slug + row.plan}
                  row={row}
                  rank={i + 5}
                  leaderUSD={leader.usd ?? 0}
                />
              ))}
            </ol>
            {tail.length > SHOWN && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="mt-3 rounded-full border border-rule px-3 py-1 text-xs font-medium text-ink-muted transition-colors hover:border-rule-strong hover:text-ink"
              >
                {showAll ? "Show fewer" : `Show all ${priced.length} plans`}
              </button>
            )}
          </div>
        )}

        {/* Kept, and kept behind the priced rows. "Helius publishes no
            Ethereum plan" is an answer a reader moving the slider wants; a
            missing price sorted in among the real ones as $0 is the bug
            this bench shipped once already. */}
        {unpriced.length > 0 && (
          <details className="mt-6 rounded-xl border border-rule px-4 py-3">
            <summary className="cursor-pointer text-sm text-ink-muted hover:text-ink transition-colors">
              {unpriced.length} provider{unpriced.length === 1 ? "" : "s"} quote
              nothing at {fmtRequests(requests)}
            </summary>
            <ul className="mt-3 space-y-2 text-sm">
              {unpriced.map((row) => (
                <li key={row.slug} className="flex items-start gap-2 text-ink-muted">
                  <ProviderMark slug={row.slug} name={row.name} size={16} />
                  <span>
                    {/* Full name here, not the brand: Helius and Helius
                        Dedicated both quote nothing on Ethereum, for
                        different reasons. */}
                    <Link
                      href={`/products/${row.slug}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {row.name}
                    </Link>{" "}
                    {row.reason}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <p className="mt-5 text-[11px] text-ink-faint">
          {onPublished
            ? `At ${onPublished.label} the grid below gives the metered winner for every workload; this list adds flat-rate nodes, which can undercut it. `
            : "Exact at every plan boundary, linear in between, which is the real shape of a metered bill. "}
          Paid plans only: free tiers are ranked on bench 283 by what their
          allowance buys. Pricing catalogue as of {file.catalogueAsOf}; a
          provider with no plan for the volume is listed as quoting nothing,
          never as free.
        </p>
      </div>
    </section>
  );
}

/** The workloads the gauges rank, in the order the methodology lists them. */
const GRID_PROFILES = ["simple-read", "dapp", "indexer", "trace", "solana-bot"];

/**
 * The fifteen cells the findings and the FAQ talk about: the cheapest
 * metered plan for each workload at each published volume. Metered only,
 * because that is the cohort the gauges rank and the copy counts (Dwellir
 * seven, BlockPI three, Syndica two, three ties at $49); flat-rate nodes are
 * in the calculator above. No selectors: one glance gives every answer.
 */
export function RpcCostWinnersGrid() {
  const file = rpcCostCurves();
  if (!file) return null;
  const profiles = GRID_PROFILES.map((id) =>
    file.profiles.find((p) => p.id === id),
  ).filter((p): p is NonNullable<typeof p> => Boolean(p));
  if (profiles.length === 0) return null;

  return (
    <section
      id="by-workload"
      className="mt-8 rounded-2xl border border-rule bg-surface p-5 shadow-sm sm:p-7"
      aria-label="Cheapest metered plan by workload and volume"
    >
      <p className="label-mono text-accent">By workload</p>
      <h2 className="mt-1 text-xl sm:text-2xl font-semibold tracking-tight text-ink">
        The cheapest metered plan, workload by workload
      </h2>
      <p className="mt-1 text-sm text-ink-muted max-w-prose">
        Five method mixes at three monthly volumes, plans billed per request
        only. The winner changes with the mix, by multiples rather than
        percent, which is why there is no single cheapest provider.
      </p>
      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="py-2 pr-3 text-left font-medium label-mono text-ink-faint">
                Workload
              </th>
              {PUBLISHED.map((v) => (
                <th
                  key={v.label}
                  className="py-2 px-2 text-left font-medium label-mono text-ink-faint"
                >
                  {v.label} / month
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id}>
                <th
                  scope="row"
                  className="border-t border-rule py-3 pr-3 text-left align-top font-medium text-ink"
                >
                  {p.label}
                  <span className="block text-[11px] font-normal text-ink-faint">
                    {p.chain === "solana" ? "Solana" : "Ethereum"}
                    {p.id === "indexer" || p.id === "trace" ? ", archive" : ""}
                  </span>
                </th>
                {PUBLISHED.map((v) => {
                  const metered = rpcCostRankAt(p.id, v.requests).priced.filter(
                    (r) => r.cohort === "usage",
                  );
                  const best = metered[0]?.usd ?? null;
                  const top =
                    best === null
                      ? []
                      : metered.filter((r) => Math.abs((r.usd ?? 0) - best) < 0.005);
                  return (
                    <td
                      key={v.label}
                      className="border-t border-rule py-3 px-2 align-top"
                    >
                      {top.length === 0 ? (
                        <span className="text-ink-faint">-</span>
                      ) : (
                        <>
                          <span className="block tabular-nums text-base font-semibold text-ink">
                            {fmtUSD(best)}
                            <span className="text-xs font-normal text-ink-faint">/mo</span>
                          </span>
                          {top.map((r) => (
                            <Link
                              key={r.slug}
                              href={`/products/${r.slug}`}
                              className="mt-1 flex min-w-0 items-center gap-1.5 text-ink-soft hover:text-ink hover:underline"
                            >
                              <ProviderMark slug={r.slug} name={r.name} size={14} />
                              <span className="truncate">
                                {brandOf(r.name)}
                                <span className="text-ink-faint">
                                  {" "}
                                  {shortPlan(r.planName || planLabel(r.plan))}
                                  {!r.verified ? " (unverified)" : ""}
                                </span>
                              </span>
                            </Link>
                          ))}
                          {top.length > 1 && (
                            <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-ink-faint">
                              tie
                            </span>
                          )}
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Syndica's plans are named after the calculator inputs they came from. */
function shortPlan(name: string): string {
  // "Calculator: 200M calls @ 300 RPS, 5 users" reads as "200M calls".
  const n = name.replace(/^Calculator:\s*/, "").split(" @")[0] ?? name;
  return n.length > 22 ? `${n.slice(0, 20).trimEnd()}…` : n;
}

function ArchiveSwitch({
  archive,
  onChange,
}: {
  archive: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="State depth"
      className="inline-flex shrink-0 rounded-full border border-rule bg-paper p-1 text-sm shadow-sm"
    >
      {[
        { v: false, label: "Recent state" },
        { v: true, label: "Archive data" },
      ].map((o) => (
        <button
          key={o.label}
          type="button"
          role="radio"
          aria-checked={archive === o.v}
          onClick={() => onChange(o.v)}
          className={`rounded-full px-4 py-1.5 font-medium transition-colors ${
            archive === o.v
              ? "bg-ink text-paper shadow-sm"
              : "text-ink-muted hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Every row gets a mark: the provider's logo, or its initial on a tinted
 * disc so a row without a logo does not read as a missing image.
 */
function ProviderMark({ slug, name, size }: { slug: string; name: string; size: number }) {
  if (hasLogo(slug)) return <ProviderLogo slug={slug} name={name} size={size} />;
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-ink/10 font-semibold text-ink-soft"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
    >
      {brandOf(name).charAt(0).toUpperCase()}
    </span>
  );
}

function Tags({ row }: { row: RpcCostRankedRow }) {
  return (
    <>
      {row.cohort === "dedicated" && (
        <span className="rounded-full border border-rule px-1.5 py-px text-[10px] uppercase tracking-wider text-ink-faint">
          flat rate
        </span>
      )}
      {!row.verified && (
        <span
          title="The catalogue marks this price uncertain: part of it is unpublished or no longer published."
          className="rounded-full border border-warn/50 px-1.5 py-px text-[10px] uppercase tracking-wider text-warn"
        >
          unverified
        </span>
      )}
    </>
  );
}

function BestPlanCard({
  leader,
  next,
  cheaperUnverified,
  requests,
  plans,
  dearest,
}: {
  leader: RpcCostRankedRow;
  next?: RpcCostRankedRow;
  cheaperUnverified?: RpcCostRankedRow;
  requests: number;
  plans: number;
  dearest: number | null;
}) {
  const gap =
    next && next.usd !== null && leader.usd !== null ? next.usd - leader.usd : null;
  const spread =
    dearest !== null && leader.usd !== null && leader.usd > 0 ? dearest / leader.usd : null;
  return (
    <Link
      href={`/products/${leader.slug}`}
      className="group block rounded-2xl border-2 border-accent bg-accent-soft/40 p-5 sm:p-6 transition-colors hover:bg-accent-soft/70"
    >
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div className="flex min-w-0 items-center gap-4">
          <span className="rounded-2xl bg-paper p-2 shadow-sm">
            <ProviderMark slug={leader.slug} name={leader.name} size={44} />
          </span>
          <div className="min-w-0">
            <p className="label-mono text-accent">Cheapest plan</p>
            <p className="mt-0.5 truncate text-2xl sm:text-3xl font-semibold tracking-tight text-ink">
              {brandOf(leader.name)}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-ink-muted">
              {leader.planName || planLabel(leader.plan)}
              <Tags row={leader} />
            </p>
          </div>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-4xl sm:text-5xl font-semibold tabular-nums tracking-tight text-ink">
            {fmtUSD(leader.usd)}
            <span className="ml-1 text-base font-normal text-ink-muted">/mo</span>
          </p>
          <p className="mt-0.5 text-xs tabular-nums text-ink-faint">
            {fmtUSD(perMillion(leader.usd, requests))} per million requests
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 border-t border-accent/20 pt-4 text-sm sm:grid-cols-3">
        <Stat label="Next verified plan">
          {next && gap !== null ? (
            gap < 0.005 ? (
              <>Tied with {brandOf(next.name)}</>
            ) : (
              <>
                {brandOf(next.name)},{" "}
                <span className="tabular-nums">{fmtUSD(gap)}</span> more a month
              </>
            )
          ) : (
            "-"
          )}
        </Stat>
        <Stat label="Plans priced at this volume">
          <span className="tabular-nums">{plans}</span>
          {spread !== null && spread > 1.05 && (
            <>
              , dearest <span className="tabular-nums">{spread < 10 ? spread.toFixed(1) : Math.round(spread)}x</span>
            </>
          )}
        </Stat>
        <Stat label="Product page">
          <span className="inline-flex items-center gap-1 text-ink group-hover:underline">
            {brandOf(leader.name)}
            <ArrowUpRight size={14} strokeWidth={2} />
          </span>
        </Stat>
      </div>

      {cheaperUnverified && (
        <p className="mt-3 text-xs text-ink-muted">
          {brandOf(cheaperUnverified.name)}{" "}
          {cheaperUnverified.planName || planLabel(cheaperUnverified.plan)} lists{" "}
          {fmtUSD(cheaperUnverified.usd)}/mo, but its price is not verified, so it is
          not the headline answer.
        </p>
      )}
      {leader.usd === 0 && (
        <p className="mt-3 text-xs text-ink-muted">
          $0 at this volume: the plan&apos;s included allowance covers it.
        </p>
      )}
    </Link>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">{label}</p>
      <p className="mt-1 text-ink-soft">{children}</p>
    </div>
  );
}

function PodiumCard({
  row,
  rank,
  leaderUSD,
}: {
  row: RpcCostRankedRow;
  rank: number;
  leaderUSD: number;
}) {
  const ratio = leaderUSD > 0 && row.usd !== null ? row.usd / leaderUSD : null;
  return (
    <Link
      href={`/products/${row.slug}`}
      className="group flex flex-col justify-between gap-3 rounded-xl border border-rule bg-paper p-4 transition-colors hover:border-rule-strong hover:bg-paper-soft"
    >
      <div className="flex items-center gap-3">
        <span className="tabular-nums text-xs text-ink-faint">#{rank}</span>
        <ProviderMark slug={row.slug} name={row.name} size={24} />
        <span className="min-w-0">
          <span className="block truncate font-semibold text-ink group-hover:underline">
            {brandOf(row.name)}
          </span>
          <span className="block truncate text-xs text-ink-faint">
            {row.planName || planLabel(row.plan)}
          </span>
        </span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="flex flex-wrap gap-1">
          <Tags row={row} />
        </span>
        <span className="text-right">
          <span className="block text-xl font-semibold tabular-nums text-ink">
            {fmtUSD(row.usd)}
            <span className="text-xs font-normal text-ink-faint">/mo</span>
          </span>
          {ratio !== null && ratio >= 1.005 && (
            <span className="block text-[11px] tabular-nums text-ink-faint">
              {ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}x the cheapest
            </span>
          )}
        </span>
      </div>
    </Link>
  );
}

function RankRow({
  row,
  rank,
  leaderUSD,
}: {
  row: RpcCostRankedRow;
  rank: number;
  leaderUSD: number;
}) {
  const ratio = leaderUSD > 0 && row.usd !== null ? row.usd / leaderUSD : null;
  return (
    <li>
      <Link
        href={`/products/${row.slug}`}
        className="group -mx-2 grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-paper-soft"
      >
        <span className="tabular-nums text-xs text-ink-faint">#{rank}</span>
        <span className="flex min-w-0 items-center gap-2.5">
          <ProviderMark slug={row.slug} name={row.name} size={20} />
          <span className="min-w-0">
            <span className="block truncate font-medium text-ink group-hover:underline">
              {brandOf(row.name)}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-ink-faint">
              <span className="truncate">{row.planName || planLabel(row.plan)}</span>
              <Tags row={row} />
            </span>
          </span>
        </span>
        <span className="text-right">
          <span className="block whitespace-nowrap tabular-nums font-semibold text-ink">
            {fmtUSD(row.usd)}
            <span className="font-normal text-ink-faint">/mo</span>
          </span>
          {ratio !== null && ratio >= 1.005 && (
            <span className="block text-[11px] tabular-nums text-ink-faint">
              {ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}x
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

function fmtRate(rps: number): string {
  if (rps >= 100) return Math.round(rps).toLocaleString("en-US");
  if (rps >= 1) return rps.toFixed(1).replace(/\.0$/, "");
  return rps.toFixed(2);
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
