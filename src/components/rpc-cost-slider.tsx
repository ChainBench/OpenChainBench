"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import { hasLogo } from "@/lib/logo-manifest";
import {
  rpcCostCurveProfile,
  rpcCostCurves,
  rpcCostQuoteAt,
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

/** Line colours for the runners-up on the chart; the cheapest line is the accent. */
const SERIES = ["#60a5fa", "#a78bfa", "#34d399", "#f472b6"];

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
  const leader = priced[0];
  const rest = priced.slice(1);
  const visible = showAll ? rest : rest.slice(0, SHOWN - 1);
  const onPublished = PUBLISHED.find((p) => p.requests === requests);
  const rps = requests / (30 * 86400);

  return (
    <section
      id="calculator"
      className="mt-8 card-soft rounded-2xl p-4 sm:p-6 lg:p-8"
      aria-label="RPC cost calculator"
    >
      <p className="label-mono text-accent">Calculator</p>
      <h2 className="mt-1 text-xl sm:text-2xl font-semibold tracking-tight text-ink">
        Which RPC plan is cheapest at your volume?
      </h2>
      <p className="mt-1 text-sm text-ink-muted max-w-prose">
        Ethereum, a typical dapp mix. Every provider&apos;s published plans are
        priced, metered and flat rate, and the cheapest one that can serve the
        month wins.
      </p>

      {/* Controls */}
      <div className="mt-6 rounded-xl border border-rule bg-paper-soft/60 p-4 sm:p-5">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <p className="label-mono text-ink-faint">Requests per month</p>
            <p className="mt-1 text-4xl sm:text-5xl font-semibold tabular-nums tracking-tight text-ink">
              {fmtRequests(requests)}
            </p>
            <p className="mt-1 text-xs tabular-nums text-ink-faint">
              about {fmtRate(rps)} requests per second on average
            </p>
          </div>
          <ArchiveSwitch archive={archive} onChange={setArchive} />
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
          className="mt-5 w-full accent-[var(--color-accent)] cursor-pointer"
        />
        <div className="relative mt-1 h-5 text-[11px] tabular-nums text-ink-faint">
          <span className="absolute left-0">{fmtRequests(floor)}</span>
          {PUBLISHED.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setRequests(p.requests)}
              style={{ left: `${(stepOf(p.requests, floor, ceiling) / STEPS * 100).toFixed(1)}%` }}
              className={`absolute -translate-x-1/2 rounded px-1 transition-colors hover:text-ink ${
                requests === p.requests ? "text-ink font-semibold" : ""
              }`}
            >
              {p.label}
            </button>
          ))}
          <span className="absolute right-0">{fmtRequests(ceiling)}</span>
        </div>
        <p className="mt-3 text-xs text-ink-faint">
          {archive
            ? "Archive: every call reads state older than the last ~128 blocks. Plans without archive drop out, and providers that bill archive higher, Chainstack at 2 RU instead of 1, are priced at that rate."
            : "Recent state only: no call reads deeper than the last ~128 blocks."}
        </p>
      </div>

      {/* Answer + chart */}
      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {leader ? (
          <BestPlanCard leader={leader} next={priced[1]} requests={requests} />
        ) : (
          <div className="rounded-xl border border-rule p-5 text-sm text-ink-muted">
            No provider publishes a plan for this volume.
          </div>
        )}
        <CostChart
          profileId={profileId}
          requests={requests}
          floor={floor}
          ceiling={ceiling}
          runnersUp={priced.slice(1, 1 + SERIES.length)}
          onPick={(r) => setRequests(roundRequests(r))}
        />
      </div>

      {/* Ranking */}
      {visible.length > 0 && leader && leader.usd !== null && (
        <div className="mt-6">
          <p className="label-mono text-ink-faint">Every other plan at {fmtRequests(requests)}</p>
          <ol className="mt-2 divide-y divide-rule">
            {visible.map((row, i) => (
              <RankRow
                key={row.slug}
                row={row}
                rank={i + 2}
                leaderUSD={leader.usd ?? 0}
                maxUSD={(showAll ? rest : visible).at(-1)?.usd ?? 0}
                color={i < SERIES.length ? SERIES[i] : undefined}
              />
            ))}
          </ol>
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
                <Link href={`/products/${row.slug}`} className="font-medium text-ink hover:underline">
                  {brandOf(row.name)}
                </Link>
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
      className="inline-flex rounded-lg border border-rule bg-paper p-1 text-sm"
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
          className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
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

function BestPlanCard({
  leader,
  next,
  requests,
}: {
  leader: RpcCostRankedRow;
  next?: RpcCostRankedRow;
  requests: number;
}) {
  const gap =
    next && next.usd !== null && leader.usd !== null ? next.usd - leader.usd : null;
  return (
    <Link
      href={`/products/${leader.slug}`}
      className="group relative flex flex-col justify-between overflow-hidden rounded-xl border-2 border-accent bg-accent-soft/40 p-5 transition-colors hover:bg-accent-soft/70"
    >
      <div>
        <p className="label-mono text-accent">Cheapest plan</p>
        <div className="mt-3 flex items-center gap-3">
          {hasLogo(leader.slug) && (
            <ProviderLogo slug={leader.slug} name={leader.name} size={40} />
          )}
          <div className="min-w-0">
            <p className="text-2xl font-semibold tracking-tight text-ink truncate">
              {brandOf(leader.name)}
            </p>
            <p className="text-sm text-ink-muted">
              {leader.planName || planLabel(leader.plan)}
              {leader.cohort === "dedicated" ? " · flat rate" : ""}
            </p>
          </div>
        </div>
        {next && gap !== null && (
          <p className="mt-5 text-sm text-ink-soft">
            {gap < 0.005 ? (
              <>Tied with {brandOf(next.name)} at this volume.</>
            ) : (
              <>
                <span className="font-semibold tabular-nums text-ink">
                  {fmtUSD(gap)}
                </span>{" "}
                a month less than the next plan, {brandOf(next.name)}{" "}
                {next.planName || planLabel(next.plan)}.
              </>
            )}
          </p>
        )}
        {leader.usd === 0 && (
          <p className="mt-5 text-sm text-ink-soft">
            A free plan covers this volume outright.
          </p>
        )}
      </div>
      <div className="mt-6 flex items-end justify-between gap-3">
        <div>
          <p className="text-4xl font-semibold tabular-nums tracking-tight text-ink">
            {fmtUSD(leader.usd)}
            <span className="ml-1 text-base font-normal text-ink-muted">/mo</span>
          </p>
          <p className="mt-0.5 text-xs tabular-nums text-ink-faint">
            {fmtUSD(perMillion(leader.usd, requests))} per million requests
          </p>
        </div>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted group-hover:text-ink">
          Product page
          <ArrowUpRight size={14} strokeWidth={2} />
        </span>
      </div>
    </Link>
  );
}

function RankRow({
  row,
  rank,
  leaderUSD,
  maxUSD,
  color,
}: {
  row: RpcCostRankedRow;
  rank: number;
  leaderUSD: number;
  maxUSD: number;
  color?: string;
}) {
  const usd = row.usd ?? 0;
  // Bar length on a log scale between the leader and the dearest row shown:
  // prices here span 10x to 100x, and a linear bar would leave every row but
  // the last as a sliver.
  const lo = Math.max(leaderUSD, 0.01);
  const hi = Math.max(maxUSD, lo * 1.0001);
  const t = Math.min(1, Math.max(0, Math.log(Math.max(usd, lo) / lo) / Math.log(hi / lo)));
  const ratio = leaderUSD > 0 ? usd / leaderUSD : null;
  return (
    <li>
      <Link
        href={`/products/${row.slug}`}
        className="group grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2.5 sm:grid-cols-[1.75rem_minmax(0,14rem)_minmax(0,1fr)_auto] rounded-md -mx-2 px-2 transition-colors hover:bg-paper-soft"
      >
        <span className="tabular-nums text-xs text-ink-faint">
          {String(rank).padStart(2, "0")}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          {color && (
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: color }}
            />
          )}
          {hasLogo(row.slug) && (
            <ProviderLogo slug={row.slug} name={row.name} size={18} />
          )}
          <span className="min-w-0">
            <span className="block truncate font-medium text-ink group-hover:underline">
              {brandOf(row.name)}
            </span>
            <span className="block truncate text-xs text-ink-faint sm:hidden">
              {row.planName || planLabel(row.plan)}
              {row.cohort === "dedicated" ? " · flat rate" : ""}
            </span>
          </span>
        </span>
        <span className="hidden min-w-0 items-center gap-3 sm:flex">
          <span className="truncate text-sm text-ink-muted">
            {row.planName || planLabel(row.plan)}
            {row.cohort === "dedicated" && (
              <span className="ml-1.5 rounded border border-rule px-1 py-px text-[10px] uppercase tracking-wider text-ink-faint">
                flat rate
              </span>
            )}
          </span>
          <span className="ml-auto hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-rule md:block">
            <span
              className="block h-full rounded-full bg-ink-faint/60"
              style={{ width: `${(8 + t * 92).toFixed(1)}%` }}
            />
          </span>
        </span>
        <span className="text-right">
          <span className="block tabular-nums font-semibold text-ink whitespace-nowrap">
            {fmtUSD(row.usd)}
            <span className="font-normal text-ink-faint">/mo</span>
          </span>
          {ratio !== null && ratio >= 1.005 && (
            <span className="block text-[11px] tabular-nums text-ink-faint">
              {ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}x the cheapest
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

/**
 * Monthly bill against volume, both axes logarithmic: four and a half decades
 * of requests and three of dollars. The accent line is the cheapest plan at
 * every volume (whoever it is there), the others are the runners-up at the
 * selected volume, followed across the whole range. Clicking or dragging on
 * the plot moves the volume.
 */
function CostChart({
  profileId,
  requests,
  floor,
  ceiling,
  runnersUp,
  onPick,
}: {
  profileId: string;
  requests: number;
  floor: number;
  ceiling: number;
  runnersUp: RpcCostRankedRow[];
  onPick: (requests: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const W = 640;
  const H = 300;
  const PAD = { l: 52, r: 14, t: 14, b: 28 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const N = 90;

  const data = useMemo(() => {
    const xs = Array.from({ length: N }, (_, i) =>
      floor * Math.pow(ceiling / floor, i / (N - 1)),
    );
    // Where the cheapest bill is $0 a free plan covers the month, and a log
    // axis has no zero to draw it on: the chart shades that span instead.
    let freeUntil: number | null = null;
    const envelope = xs.map((r) => {
      const top = rpcCostRankAt(profileId, r).priced[0];
      if (top && top.usd === 0) freeUntil = r;
      return top && top.usd !== null && top.usd > 0 ? top.usd : null;
    });
    const profile = rpcCostCurveProfile(profileId);
    const lines = runnersUp.map((row) => {
      const prov = profile?.providers.find((p) => p.slug === row.slug);
      return xs.map((r) => {
        if (!prov) return null;
        const q = rpcCostQuoteAt(prov, r);
        return q.usd !== null && q.usd > 0 ? q.usd : null;
      });
    });
    return { xs, envelope, lines, freeUntil };
  }, [profileId, floor, ceiling, runnersUp]);

  const all = [...data.envelope, ...data.lines.flat()].filter(
    (v): v is number => v !== null,
  );
  const yMin = Math.pow(10, Math.floor(Math.log10(Math.max(Math.min(...all, 1), 0.1))));
  const yMax = Math.pow(10, Math.ceil(Math.log10(Math.max(...all, 10))));
  // Rounded to a tenth of a unit: server and client print a float's last
  // digits differently, and React reports every such attribute as a
  // hydration mismatch.
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const xFor = (r: number) =>
    r1(PAD.l + (Math.log(r / floor) / Math.log(ceiling / floor)) * plotW);
  const yFor = (usd: number) =>
    r1(PAD.t + plotH - (Math.log(usd / yMin) / Math.log(yMax / yMin)) * plotH);

  const pathOf = (ys: (number | null)[]) => {
    let d = "";
    let pen = false;
    ys.forEach((v, i) => {
      const x = data.xs[i];
      if (v === null || x === undefined) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${xFor(x).toFixed(1)},${yFor(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const yTicks: number[] = [];
  for (let v = yMin; v <= yMax * 1.0001; v *= 10) yTicks.push(v);
  const xTicks = [1e5, 1e6, 1e7, 1e8, 1e9].filter((v) => v >= floor && v <= ceiling);

  const pick = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const x = ((clientX - box.left) / box.width) * W;
    const t = Math.min(1, Math.max(0, (x - PAD.l) / plotW));
    onPick(floor * Math.pow(ceiling / floor, t));
  };

  const freeUntil = data.freeUntil;

  const cx = xFor(requests);
  const leaderNow = rpcCostRankAt(profileId, requests).priced[0]?.usd ?? null;

  return (
    <figure className="rounded-xl border border-rule bg-paper p-3 sm:p-4">
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-faint">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-accent" aria-hidden />
          Cheapest plan at each volume
        </span>
        {runnersUp.map((row, i) => (
          <span key={row.slug} className="inline-flex items-center gap-1.5">
            <span
              className="h-0.5 w-4 rounded"
              style={{ background: SERIES[i] }}
              aria-hidden
            />
            {brandOf(row.name)}
          </span>
        ))}
      </figcaption>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 block w-full touch-none cursor-crosshair select-none"
        role="img"
        aria-label="Monthly bill by monthly request volume, log scales"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pick(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) pick(e.clientX);
        }}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={yFor(v)}
              y2={yFor(v)}
              stroke="var(--color-rule)"
              strokeDasharray="2 4"
            />
            <text
              x={PAD.l - 8}
              y={yFor(v) + 3}
              textAnchor="end"
              className="fill-ink-faint text-[10px] tabular-nums"
            >
              {fmtUSDShort(v)}
            </text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text
            key={v}
            x={xFor(v)}
            y={H - 8}
            textAnchor="middle"
            className="fill-ink-faint text-[10px] tabular-nums"
          >
            {fmtRequests(v)}
          </text>
        ))}

        {freeUntil !== null && (
          <g>
            <rect
              x={PAD.l}
              y={PAD.t}
              width={r1(Math.max(0, xFor(freeUntil) - PAD.l))}
              height={plotH}
              fill="var(--color-good)"
              fillOpacity={0.08}
            />
            <text
              x={PAD.l + 6}
              y={PAD.t + plotH - 8}
              className="fill-ink-faint text-[10px]"
            >
              Free plans cover it
            </text>
          </g>
        )}
        {data.lines.map((ys, i) => (
          <path
            key={runnersUp[i]?.slug ?? i}
            d={pathOf(ys)}
            fill="none"
            stroke={SERIES[i]}
            strokeWidth={1.5}
            strokeOpacity={0.85}
            strokeLinejoin="round"
          />
        ))}
        <path
          d={pathOf(data.envelope)}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={3}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        <line
          x1={cx}
          x2={cx}
          y1={PAD.t}
          y2={PAD.t + plotH}
          stroke="var(--color-ink)"
          strokeOpacity={0.35}
          strokeDasharray="3 3"
        />
        {leaderNow !== null && leaderNow > 0 && (
          <g>
            <circle cx={cx} cy={yFor(leaderNow)} r={6} fill="var(--color-paper)" />
            <circle cx={cx} cy={yFor(leaderNow)} r={4} fill="var(--color-accent)" />
          </g>
        )}
      </svg>
      <p className="mt-1 text-[11px] text-ink-faint">
        Click or drag on the chart to move the volume. Both axes are logarithmic.
      </p>
    </figure>
  );
}

function fmtUSDShort(v: number): string {
  if (v >= 1e6) return `$${trim(v / 1e6)}M`;
  if (v >= 1e3) return `$${trim(v / 1e3)}k`;
  if (v >= 1) return `$${Math.round(v)}`;
  return `$${v}`;
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
