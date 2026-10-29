"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import { hasLogo } from "@/lib/logo-manifest";
import { countAt, fmtCount, fmtUSD, roundCount, stepOf } from "@/components/wallet-cost-calculator";
import {
  serverWalletCurves,
  serverWalletLeader,
  serverWalletRankAt,
  serverWalletWorkload,
  type ServerWalletRow,
} from "@/lib/server-wallet-cost-curve";

/**
 * Bench 310's calculator: what a server or agent wallet workload costs at
 * each vendor. The scenario switch matters most, since one vendor bills per
 * active wallet and nothing per transaction (Circle), others per signature,
 * per operation or per request, so the same vendor is first on one scenario
 * and near last on another. Each scenario has its own axis: agents, a bot's
 * monthly transactions, or payout wallets.
 *
 * Reads the committed curve through src/lib/server-wallet-cost-curve.ts.
 */

const STEPS = 1000;
const SHOWN = 8;

export function ServerWalletCostCalculator() {
  const file = serverWalletCurves();
  const headScenario = file?.headline.scenario ?? "agents";
  const sizeOf = (id: string) =>
    file?.scenarios.find((s) => s.id === id)?.sizes.find((z) => z.id === file.headline.size)?.x ?? 0;
  const [scenarioId, setScenarioId] = useState(headScenario);
  const [x, setX] = useState(sizeOf(headScenario));
  const [showAll, setShowAll] = useState(false);

  const { priced, unpriced } = useMemo(() => serverWalletRankAt(scenarioId, x), [scenarioId, x]);

  if (!file || file.scenarios.length === 0) return null;
  const s = file.scenarios.find((v) => v.id === scenarioId) ?? file.scenarios[0];
  if (!s) return null;
  const { wallets, tx } = serverWalletWorkload(s, x);

  const leader = serverWalletLeader(priced);
  const cheaperBelow = leader
    ? priced.find((r) => r !== leader && (r.usd ?? 0) < (leader.usd ?? 0) - 0.005)
    : undefined;
  const rest = priced.filter((r) => r !== leader);
  const podium = rest.slice(0, 3);
  const tail = rest.slice(3);
  const visibleTail = showAll ? tail : tail.slice(0, SHOWN);
  const dearest = priced.at(-1)?.usd ?? null;
  const onSize = s.sizes.find((z) => z.x === x);

  const pickScenario = (id: string) => {
    const next = file.scenarios.find((v) => v.id === id);
    setScenarioId(id);
    // Each scenario has its own axis, so the size resets to that scenario's
    // headline size rather than carrying a number that means something else.
    setX(next?.sizes.find((z) => z.id === file.headline.size)?.x ?? next?.floor ?? 0);
  };

  return (
    <section
      id="calculator"
      className="mt-8 overflow-hidden rounded-2xl border border-rule bg-surface shadow-sm"
      aria-label="Server and agent wallet cost calculator"
    >
      <div className="border-b border-rule bg-paper-soft/70 p-5 sm:p-7">
        <div className="max-w-prose">
          <p className="label-mono text-accent">Calculator</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            Which vendor is cheapest for your bot, payouts or agents?
          </h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            Wallets your backend or your agents hold and sign with, no end user. Every vendor&apos;s
            published self-serve plans, priced for one month. Gas is excluded.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Workload"
          className="mt-5 inline-flex max-w-full flex-wrap gap-1 rounded-2xl border border-rule bg-paper p-1 text-sm shadow-sm"
        >
          {file.scenarios.map((v) => (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={scenarioId === v.id}
              onClick={() => pickScenario(v.id)}
              className={`rounded-xl px-3.5 py-1.5 text-left transition-colors ${
                scenarioId === v.id ? "bg-ink text-paper shadow-sm" : "text-ink-muted hover:text-ink"
              }`}
            >
              <span className="block font-medium">{v.label}</span>
              <span className={`block text-[11px] ${scenarioId === v.id ? "text-paper/70" : "text-ink-faint"}`}>
                {scenarioHint(v)}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-5xl font-semibold tabular-nums tracking-tight text-ink sm:text-6xl">{fmtCount(x)}</p>
          <p className="text-sm text-ink-muted">
            {s.axis}
            <span className="text-ink-faint">
              {" "}
              · {fmtCount(wallets)} wallet{wallets === 1 ? "" : "s"} · {fmtCount(tx)} transactions a month
            </span>
          </p>
        </div>

        <input
          type="range"
          min={0}
          max={STEPS}
          step={1}
          value={stepOf(x, s.floor, s.ceiling)}
          onChange={(e) => setX(roundCount(countAt(Number(e.target.value), s.floor, s.ceiling)))}
          aria-label={s.axis}
          aria-valuetext={`${fmtCount(x)} ${s.axis}`}
          className="mt-5 w-full cursor-pointer accent-[var(--color-accent)]"
        />
        <div className="relative mt-1 h-6 text-[11px] tabular-nums text-ink-faint">
          {!s.sizes.some((z) => z.x === s.floor) && (
            <span className="absolute left-0 top-1">{fmtCount(s.floor)}</span>
          )}
          {s.sizes.map((z) => (
            <button
              key={z.id}
              type="button"
              onClick={() => setX(z.x)}
              style={{ left: `${((stepOf(z.x, s.floor, s.ceiling) / STEPS) * 100).toFixed(1)}%` }}
              className={`absolute top-0 -translate-x-1/2 rounded-full border px-2 py-0.5 transition-colors ${
                x === z.x ? "border-ink bg-ink text-paper" : "border-rule bg-paper hover:border-rule-strong hover:text-ink"
              }`}
            >
              {fmtCount(z.x)}
            </button>
          ))}
          {!s.sizes.some((z) => z.x === s.ceiling) && (
            <span className="absolute right-0 top-1">{fmtCount(s.ceiling)}</span>
          )}
        </div>
        <p className="mt-3 text-xs text-ink-faint">
          {s.label}: {scenarioSentence(s)} A transaction is one signature and one broadcast; creating
          a wallet is a one-time cost and is left out.
        </p>
      </div>

      <div className="p-5 sm:p-7">
        {leader ? (
          <BestCard leader={leader} cheaperBelow={cheaperBelow} tx={tx} plans={priced.length} dearest={dearest} />
        ) : (
          <div className="rounded-xl border border-rule p-5 text-sm text-ink-muted">
            No vendor publishes a self-serve price for this workload.
          </div>
        )}

        {podium.length > 0 && leader && (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {podium.map((row) => (
              <PodiumCard key={row.slug} row={row} rank={rankOf(priced, row)} leaderUSD={leader.usd ?? 0} tx={tx} />
            ))}
          </div>
        )}

        {visibleTail.length > 0 && leader && (
          <div className="mt-6">
            <p className="label-mono text-ink-faint">Every other vendor</p>
            <ol className="mt-2 divide-y divide-rule">
              {visibleTail.map((row) => (
                <RankRow key={row.slug} row={row} rank={rankOf(priced, row)} leaderUSD={leader.usd ?? 0} tx={tx} />
              ))}
            </ol>
            {tail.length > SHOWN && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="mt-3 rounded-full border border-rule px-3 py-1 text-xs font-medium text-ink-muted transition-colors hover:border-rule-strong hover:text-ink"
              >
                {showAll ? "Show fewer" : `Show all ${priced.length} vendors`}
              </button>
            )}
          </div>
        )}

        {unpriced.length > 0 && (
          <details className="mt-6 rounded-xl border border-rule px-4 py-3">
            <summary className="cursor-pointer text-sm text-ink-muted transition-colors hover:text-ink">
              {unpriced.length} vendor{unpriced.length === 1 ? " publishes" : "s publish"} no self-serve
              price for this workload
            </summary>
            <ul className="mt-3 space-y-2 text-sm">
              {unpriced.map((row) => (
                <li key={row.slug} className="flex items-start gap-2 text-ink-muted">
                  <Mark slug={row.slug} name={row.name} size={16} />
                  <span>
                    <Link href={`/products/${row.slug}`} className="font-medium text-ink hover:underline">
                      {row.name}
                    </Link>
                    : {row.reason}.
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <p className="mt-5 text-[11px] text-ink-faint">
          {onSize
            ? "This is one of the three sizes the table below prices for every scenario. "
            : "Exact at every plan boundary and linear in between, which is the real shape of a metered bill. "}
          &ldquo;At most&rdquo; and &ldquo;at least&rdquo; mark a price whose page reads two ways, priced
          on the reading named; the methodology gives the other. Pricing catalogue as of{" "}
          {file.catalogueAsOf}. A vendor with no published price for this workload is listed as such,
          never as free.
        </p>
      </div>
    </section>
  );
}

/** The nine cells: cheapest vendor per scenario and size. */
export function ServerWalletCostGrid() {
  const file = serverWalletCurves();
  if (!file) return null;
  return (
    <section
      id="by-scenario"
      className="mt-8 rounded-2xl border border-rule bg-surface p-5 shadow-sm sm:p-7"
      aria-label="Cheapest server wallet vendor by scenario and size"
    >
      <p className="label-mono text-accent">By scenario</p>
      <h2 className="mt-1 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
        The cheapest vendor, scenario by scenario
      </h2>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">
        A bot signs a lot from a few wallets, a payout platform signs a little from many, and agents
        sit in between. The billing unit decides who wins each one.
      </p>
      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[620px] border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="py-2 pr-3 text-left font-medium label-mono text-ink-faint">Scenario</th>
              {["Small", "Medium", "Large"].map((l) => (
                <th key={l} className="px-2 py-2 text-left font-medium label-mono text-ink-faint">
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {file.scenarios.map((s) => (
              <tr key={s.id}>
                <th scope="row" className="border-t border-rule py-3 pr-3 text-left align-top font-medium text-ink">
                  {s.label}
                  <span className="block text-[11px] font-normal text-ink-faint">{scenarioHint(s)}</span>
                </th>
                {s.sizes.map((z) => {
                  const { priced } = serverWalletRankAt(s.id, z.x);
                  // Same rule as the calculator's card: a price that is only a
                  // floor ("at least") is never named cheapest. One that sits
                  // at or under the named price is cited beside it instead.
                  const holds = priced.filter((r) => r.verified || r.bound === "upper");
                  const best = holds[0]?.usd ?? null;
                  const top = best === null ? [] : holds.filter((r) => Math.abs((r.usd ?? 0) - best) < 0.005);
                  const floors =
                    best === null ? [] : priced.filter((r) => !holds.includes(r) && (r.usd ?? 0) <= best + 0.005);
                  return (
                    <td key={z.id} className="border-t border-rule px-2 py-3 align-top">
                      <span className="block text-[11px] text-ink-faint">
                        {fmtCount(z.x)} {s.axis}
                      </span>
                      {top.length === 0 ? (
                        <span className="text-ink-faint">-</span>
                      ) : (
                        <>
                          <span className="block text-base font-semibold tabular-nums text-ink">
                            {fmtUSD(best)}
                            <span className="text-xs font-normal text-ink-faint">/mo</span>
                          </span>
                          {top.map((r) => (
                            <Link
                              key={r.slug}
                              href={`/products/${r.slug}`}
                              className="mt-1 flex min-w-0 items-center gap-1.5 text-ink-soft hover:text-ink hover:underline"
                            >
                              <Mark slug={r.slug} name={r.name} size={14} />
                              <span className="truncate">
                                {r.name}
                                <span className="text-ink-faint">
                                  {" "}
                                  {r.planName}
                                  {boundWord(r) ? ` (${boundWord(r)})` : ""}
                                </span>
                              </span>
                            </Link>
                          ))}
                          {top.length > 1 && (
                            <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-ink-faint">tie</span>
                          )}
                          {floors.map((r) => (
                            <span key={r.slug} className="mt-1 block text-[11px] leading-snug text-ink-faint">
                              {r.name} {r.planName}: at least {fmtUSD(r.usd)}, not named
                            </span>
                          ))}
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
      {file.excluded.length > 0 && (
        <p className="mt-4 text-xs text-ink-faint">
          Not priced:{" "}
          {file.excluded.map((e, i) => (
            <span key={e.slug}>
              {i > 0 ? "; " : ""}
              {e.name} ({e.reason.replace(/\.$/, "")})
            </span>
          ))}
          .
        </p>
      )}
    </section>
  );
}

type ScenarioLike = { walletsFixed: number; walletsPerX: number; txPerX: number; axis: string };

function scenarioHint(s: ScenarioLike): string {
  if (s.walletsPerX === 0) return `${fmtCount(s.walletsFixed)} wallets, many transactions`;
  return `${s.txPerX} transaction${s.txPerX === 1 ? "" : "s"} per wallet a month`;
}

function scenarioSentence(s: ScenarioLike): string {
  if (s.walletsPerX === 0) {
    return `${fmtCount(s.walletsFixed)} wallets that sign every transaction the slider sets.`;
  }
  return `each of the ${s.axis} holds one wallet that sends ${s.txPerX} transaction${s.txPerX === 1 ? "" : "s"} a month.`;
}

/** Competition rank on the cent, so tied vendors share a rank. */
function rankOf(priced: ServerWalletRow[], row: ServerWalletRow): number {
  const c = Math.round((row.usd ?? 0) * 100);
  return 1 + priced.filter((r) => Math.round((r.usd ?? 0) * 100) < c).length;
}

function boundWord(row: ServerWalletRow): string {
  if (row.verified) return "";
  return row.bound === "upper" ? "at most" : row.bound === "lower" ? "at least" : "ambiguous price";
}

function Mark({ slug, name, size }: { slug: string; name: string; size: number }) {
  if (hasLogo(slug)) return <ProviderLogo slug={slug} name={name} size={size} />;
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-ink/10 font-semibold text-ink-soft"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function BoundBadge({ row }: { row: ServerWalletRow }) {
  const w = boundWord(row);
  if (!w) return null;
  const title =
    row.bound === "upper"
      ? "The vendor's page reads two ways; this is the higher reading, so the bill is at most this. The methodology gives the other."
      : row.bound === "lower"
        ? "The vendor's page reads two ways, or meters something it does not price; this is the lower reading, so the bill is at least this."
        : "The vendor's page reads more than one way; the methodology names the reading used.";
  return (
    <span title={title} className="rounded-full border border-warn/50 px-1.5 py-px text-[10px] uppercase tracking-wider text-warn">
      {w}
    </span>
  );
}

function BestCard({
  leader,
  cheaperBelow,
  tx,
  plans,
  dearest,
}: {
  leader: ServerWalletRow;
  cheaperBelow?: ServerWalletRow;
  tx: number;
  plans: number;
  dearest: number | null;
}) {
  const spread = dearest !== null && leader.usd !== null && leader.usd > 0 ? dearest / leader.usd : null;
  return (
    <Link
      href={`/products/${leader.slug}`}
      className="group block rounded-2xl border-2 border-accent bg-accent-soft/40 p-5 transition-colors hover:bg-accent-soft/70 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div className="flex min-w-0 items-center gap-4">
          <span className="rounded-2xl bg-paper p-2 shadow-sm">
            <Mark slug={leader.slug} name={leader.name} size={44} />
          </span>
          <div className="min-w-0">
            <p className="label-mono text-accent">Cheapest vendor</p>
            <p className="mt-0.5 truncate text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{leader.name}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-ink-muted">
              {leader.planName}
              {!sameStart(leader.unit, leader.planName) && (
                <span className="text-ink-faint">· billed on {lowerFirst(leader.unit)}</span>
              )}
              <BoundBadge row={leader} />
            </p>
          </div>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-4xl font-semibold tabular-nums tracking-tight text-ink sm:text-5xl">
            {fmtUSD(leader.usd)}
            <span className="ml-1 text-base font-normal text-ink-muted">/mo</span>
          </p>
          <p className="mt-0.5 text-xs tabular-nums text-ink-faint">{fmtPerTx(leader.usd, tx)} per transaction</p>
        </div>
      </div>
      <div className="mt-5 grid gap-3 border-t border-accent/20 pt-4 text-sm sm:grid-cols-3">
        <Stat label="Vendors priced">
          <span className="tabular-nums">{plans}</span>
          {spread !== null && spread > 1.05 && (
            <>
              , dearest <span className="tabular-nums">{spread < 10 ? spread.toFixed(1) : Math.round(spread)}x</span>
            </>
          )}
        </Stat>
        <Stat label="Unit">{leader.unit}</Stat>
        <Stat label="Product page">
          <span className="inline-flex items-center gap-1 text-ink group-hover:underline">
            {leader.name}
            <ArrowUpRight size={14} strokeWidth={2} />
          </span>
        </Stat>
      </div>
      {cheaperBelow && (
        <p className="mt-3 text-xs text-ink-muted">
          {cheaperBelow.name} {cheaperBelow.planName} comes to {fmtUSD(cheaperBelow.usd)}/mo on the lower
          reading of a page that reads two ways, so it may cost more; it is listed below rather than named
          here.
        </p>
      )}
      {leader.usd === 0 && (
        <p className="mt-3 text-xs text-ink-muted">$0 for this workload: a free allowance covers it.</p>
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

function PodiumCard({ row, rank, leaderUSD, tx }: { row: ServerWalletRow; rank: number; leaderUSD: number; tx: number }) {
  const ratio = leaderUSD > 0 && row.usd !== null ? row.usd / leaderUSD : null;
  return (
    <Link
      href={`/products/${row.slug}`}
      className="group flex flex-col justify-between gap-3 rounded-xl border border-rule bg-paper p-4 transition-colors hover:border-rule-strong hover:bg-paper-soft"
    >
      <div className="flex items-center gap-3">
        <span className="text-xs tabular-nums text-ink-faint">#{rank}</span>
        <Mark slug={row.slug} name={row.name} size={24} />
        <span className="min-w-0">
          <span className="block truncate font-semibold text-ink group-hover:underline">{row.name}</span>
          <span className="block text-xs text-ink-faint">{planAndUnit(row)}</span>
        </span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="flex flex-wrap gap-1">
          <BoundBadge row={row} />
        </span>
        <span className="text-right">
          <span className="block text-xl font-semibold tabular-nums text-ink">
            {fmtUSD(row.usd)}
            <span className="text-xs font-normal text-ink-faint">/mo</span>
          </span>
          <span className="block text-[11px] tabular-nums text-ink-faint">
            {fmtPerTx(row.usd, tx)} a tx
            {ratio !== null && ratio >= 1.005 ? ` · ${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}x` : ""}
          </span>
        </span>
      </div>
    </Link>
  );
}

function RankRow({ row, rank, leaderUSD, tx }: { row: ServerWalletRow; rank: number; leaderUSD: number; tx: number }) {
  const ratio = leaderUSD > 0 && row.usd !== null ? row.usd / leaderUSD : null;
  return (
    <li>
      <Link
        href={`/products/${row.slug}`}
        className="group -mx-2 grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-paper-soft"
      >
        <span className="text-xs tabular-nums text-ink-faint">#{rank}</span>
        <span className="flex min-w-0 items-center gap-2.5">
          <Mark slug={row.slug} name={row.name} size={20} />
          <span className="min-w-0">
            <span className="block truncate font-medium text-ink group-hover:underline">{row.name}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-ink-faint">
              <span>{planAndUnit(row)}</span>
              <BoundBadge row={row} />
            </span>
          </span>
        </span>
        <span className="text-right">
          <span className="block whitespace-nowrap font-semibold tabular-nums text-ink">
            {fmtUSD(row.usd)}
            <span className="font-normal text-ink-faint">/mo</span>
          </span>
          <span className="block text-[11px] tabular-nums text-ink-faint">
            {fmtPerTx(row.usd, tx)}
            {ratio !== null && ratio >= 1.005 ? ` · ${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}x` : ""}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** Cost per transaction, three significant figures. */
export function fmtPerTx(usd: number | null, tx: number): string {
  if (usd === null || !Number.isFinite(usd) || tx <= 0) return "-";
  const v = usd / tx;
  if (v === 0) return "$0";
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${Number(v.toPrecision(3))}`;
}

/** "Prepaid credits · prepaid credits per execution second" says it twice. */
function sameStart(unit: string, plan: string): boolean {
  return Boolean(plan) && unit.toLowerCase().startsWith(plan.toLowerCase());
}

function planAndUnit(row: { planName: string; unit: string }): string {
  return sameStart(row.unit, row.planName) ? row.unit : `${row.planName} · ${lowerFirst(row.unit)}`;
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
