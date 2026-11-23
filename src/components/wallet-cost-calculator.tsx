"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import { hasLogo } from "@/lib/logo-manifest";
import {
  walletCostCurves,
  walletCostRankAt,
  type WalletCostRow,
} from "@/lib/wallet-cost-curve";

/**
 * The wallet-cost calculator: one profile switch and one app-size slider
 * answer "which embedded wallet vendor is cheapest for my app".
 *
 * The profile switch matters more than the slider. About half the cohort
 * bills per active user and nothing per transaction, the other half bills per
 * signature or per operation, so the same app ranks the vendors differently
 * depending on how often its users transact. The page says which unit each
 * vendor bills, on every row, because that is the explanation for the order.
 *
 * Reads the committed curve (src/data/wallet-cost-curves.json) through
 * src/lib/wallet-cost-curve.ts. No props: the JSON ships in this client
 * chunk instead of being inlined into every ISR render.
 */

const STEPS = 1000;
const SHOWN = 8;

export function WalletCostCalculator() {
  const file = walletCostCurves();
  const [profileId, setProfileId] = useState(file?.headline.profile ?? "consumer");
  const defaultMau = file?.volumes.find((v) => v.id === file.headline.volume)?.mau ?? 10000;
  // The MAU itself is the state, not the slider position: a round-trip
  // through the log scale would land the "10k" button on 9,990.
  const [mau, setMau] = useState(defaultMau);
  const [showAll, setShowAll] = useState(false);

  const { priced, unpriced } = useMemo(() => walletCostRankAt(profileId, mau), [profileId, mau]);

  if (!file || file.profiles.length === 0) return null;
  const profile = file.profiles.find((p) => p.id === profileId) ?? file.profiles[0];
  if (!profile) return null;
  const { floor, ceiling } = file;

  // The leader slot takes the cheapest price the catalogue states without a
  // caveat. A cheaper one with a caveat stays in the list, badged, and is
  // named on the card, so the headline answer never rests on a reading the
  // catalogue itself flags as one of two.
  const leader = priced.find((r) => r.verified) ?? priced[0];
  const cheaperUncertain = leader
    ? priced.find((r) => !r.verified && (r.usd ?? 0) < (leader.usd ?? 0) - 0.005)
    : undefined;
  const rest = priced.filter((r) => r !== leader);
  const podium = rest.slice(0, 3);
  const tail = rest.slice(3);
  const visibleTail = showAll ? tail : tail.slice(0, SHOWN);
  const dearest = priced.at(-1)?.usd ?? null;
  const tx = mau * profile.txPerUser;
  const newWallets = mau * profile.newUserShare;
  const onVolume = file.volumes.find((v) => v.mau === mau);

  return (
    <section
      id="calculator"
      className="mt-8 overflow-hidden rounded-2xl border border-rule bg-surface shadow-sm"
      aria-label="Embedded wallet cost calculator"
    >
      <div className="border-b border-rule bg-paper-soft/70 p-5 sm:p-7">
        <div className="max-w-prose">
          <p className="label-mono text-accent">Calculator</p>
          <h2 className="mt-1 text-2xl sm:text-3xl font-semibold tracking-tight text-ink">
            Which embedded wallet is cheapest for your app?
          </h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            Every vendor&apos;s published self-serve plans, priced for one month.
            Gas is excluded: it is the same gas whichever wallet signs.
          </p>
        </div>

        <ProfileSwitch
          profiles={file.profiles.map((p) => ({ id: p.id, label: p.label, tx: p.txPerUser }))}
          value={profileId}
          onChange={setProfileId}
        />

        <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-5xl sm:text-6xl font-semibold tabular-nums tracking-tight text-ink">
            {fmtCount(mau)}
          </p>
          <p className="text-sm text-ink-muted">
            monthly active users
            <span className="text-ink-faint">
              {" "}
              · {fmtCount(tx)} transactions · {fmtCount(newWallets)} new wallets a month
            </span>
          </p>
        </div>

        <input
          type="range"
          min={0}
          max={STEPS}
          step={1}
          value={stepOf(mau, floor, ceiling)}
          onChange={(e) => setMau(roundCount(countAt(Number(e.target.value), floor, ceiling)))}
          aria-label="Monthly active users"
          aria-valuetext={`${fmtCount(mau)} monthly active users`}
          className="mt-5 w-full cursor-pointer accent-[var(--color-accent)]"
        />
        <div className="relative mt-1 h-6 text-[11px] tabular-nums text-ink-faint">
          <span className="absolute left-0 top-1">{fmtCount(floor)}</span>
          {file.volumes.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setMau(v.mau)}
              style={{ left: `${((stepOf(v.mau, floor, ceiling) / STEPS) * 100).toFixed(1)}%` }}
              className={`absolute top-0 -translate-x-1/2 rounded-full border px-2 py-0.5 transition-colors ${
                mau === v.mau
                  ? "border-ink bg-ink text-paper"
                  : "border-rule bg-paper hover:border-rule-strong hover:text-ink"
              }`}
            >
              {fmtCount(v.mau)}
            </button>
          ))}
          <span className="absolute right-0 top-1">{fmtCount(ceiling)}</span>
        </div>
        <p className="mt-3 text-xs text-ink-faint">
          {profile.label}: each user sends {profile.txPerUser} transaction
          {profile.txPerUser === 1 ? "" : "s"} a month, and{" "}
          {Math.round(profile.newUserShare * 100)}% of users are new and create a
          wallet. One wallet per user.
        </p>
      </div>

      <div className="p-5 sm:p-7">
        {leader ? (
          <BestCard
            leader={leader}
            next={rest.find((r) => r.verified)}
            cheaperUncertain={cheaperUncertain}
            mau={mau}
            plans={priced.length}
            dearest={dearest}
          />
        ) : (
          <div className="rounded-xl border border-rule p-5 text-sm text-ink-muted">
            No vendor publishes a self-serve price for this app size.
          </div>
        )}

        {podium.length > 0 && leader && (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {podium.map((row, i) => (
              <PodiumCard key={row.slug} row={row} rank={i + 2} leaderUSD={leader.usd ?? 0} mau={mau} />
            ))}
          </div>
        )}

        {visibleTail.length > 0 && leader && (
          <div className="mt-6">
            <p className="label-mono text-ink-faint">Every other vendor at {fmtCount(mau)} users</p>
            <ol className="mt-2 divide-y divide-rule">
              {visibleTail.map((row, i) => (
                <RankRow key={row.slug} row={row} rank={i + 5} leaderUSD={leader.usd ?? 0} mau={mau} />
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
              {unpriced.length} vendor{unpriced.length === 1 ? " publishes" : "s publish"} no
              self-serve price at {fmtCount(mau)} users
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
          {onVolume
            ? `At ${fmtCount(onVolume.mau)} users the table below gives the cheapest vendor for every profile. `
            : "Exact at every plan boundary and linear in between, which is the real shape of a metered bill. "}
          An &ldquo;ambiguous price&rdquo; badge marks a plan whose page can be
          read more than one way; the methodology names the reading used. Pricing catalogue as of{" "}
          {file.catalogueAsOf}. A vendor with no published price for this size is
          listed as such, never as free.
        </p>
      </div>
    </section>
  );
}

/**
 * The nine cells the findings quote: the cheapest vendor for each profile at
 * each published volume, read from the same curve as the calculator.
 */
export function WalletCostGrid() {
  const file = walletCostCurves();
  if (!file) return null;
  return (
    <section
      id="by-profile"
      className="mt-8 rounded-2xl border border-rule bg-surface p-5 shadow-sm sm:p-7"
      aria-label="Cheapest embedded wallet by profile and app size"
    >
      <p className="label-mono text-accent">By profile</p>
      <h2 className="mt-1 text-xl sm:text-2xl font-semibold tracking-tight text-ink">
        The cheapest vendor, profile by profile
      </h2>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">
        Three ways an app uses its wallets, at three sizes. Vendors that bill per
        active user win as transactions per user rise; vendors that bill per
        signature or operation win small, quiet apps.
      </p>
      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[620px] border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="py-2 pr-3 text-left font-medium label-mono text-ink-faint">Profile</th>
              {file.volumes.map((v) => (
                <th key={v.id} className="px-2 py-2 text-left font-medium label-mono text-ink-faint">
                  {fmtCount(v.mau)} users
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {file.profiles.map((p) => (
              <tr key={p.id}>
                <th scope="row" className="border-t border-rule py-3 pr-3 text-left align-top font-medium text-ink">
                  {p.label}
                  <span className="block text-[11px] font-normal text-ink-faint">
                    {p.txPerUser} transactions a user
                  </span>
                </th>
                {file.volumes.map((v) => {
                  const { priced } = walletCostRankAt(p.id, v.mau);
                  const best = priced[0]?.usd ?? null;
                  const top =
                    best === null ? [] : priced.filter((r) => Math.abs((r.usd ?? 0) - best) < 0.005);
                  return (
                    <td key={v.id} className="border-t border-rule px-2 py-3 align-top">
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
                                  {!r.verified ? " (ambiguous price)" : ""}
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

function ProfileSwitch({
  profiles,
  value,
  onChange,
}: {
  profiles: { id: string; label: string; tx: number }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="How the app uses its wallets"
      className="mt-5 inline-flex max-w-full flex-wrap gap-1 rounded-2xl border border-rule bg-paper p-1 text-sm shadow-sm"
    >
      {profiles.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={value === p.id}
          onClick={() => onChange(p.id)}
          className={`rounded-xl px-3.5 py-1.5 text-left transition-colors ${
            value === p.id ? "bg-ink text-paper shadow-sm" : "text-ink-muted hover:text-ink"
          }`}
        >
          <span className="block font-medium">{p.label}</span>
          <span className={`block text-[11px] ${value === p.id ? "text-paper/70" : "text-ink-faint"}`}>
            {p.tx} transactions a user
          </span>
        </button>
      ))}
    </div>
  );
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

function Uncertain({ row }: { row: WalletCostRow }) {
  if (row.verified) return null;
  return (
    <span
      title="The vendor's page can be read more than one way for this plan. The methodology names the reading priced here and the alternative."
      className="rounded-full border border-warn/50 px-1.5 py-px text-[10px] uppercase tracking-wider text-warn"
    >
      ambiguous price
    </span>
  );
}

function BestCard({
  leader,
  next,
  cheaperUncertain,
  mau,
  plans,
  dearest,
}: {
  leader: WalletCostRow;
  next?: WalletCostRow;
  cheaperUncertain?: WalletCostRow;
  mau: number;
  plans: number;
  dearest: number | null;
}) {
  const gap = next && next.usd !== null && leader.usd !== null ? next.usd - leader.usd : null;
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
            <p className="mt-0.5 truncate text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              {leader.name}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-ink-muted">
              {leader.planName}
              <span className="text-ink-faint">· billed on {lowerFirst(leader.unit)}</span>
              <Uncertain row={leader} />
            </p>
          </div>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-4xl font-semibold tabular-nums tracking-tight text-ink sm:text-5xl">
            {fmtUSD(leader.usd)}
            <span className="ml-1 text-base font-normal text-ink-muted">/mo</span>
          </p>
          <p className="mt-0.5 text-xs tabular-nums text-ink-faint">{fmtPerUser(leader.usd, mau)} per user</p>
        </div>
      </div>
      <div className="mt-5 grid gap-3 border-t border-accent/20 pt-4 text-sm sm:grid-cols-3">
        <Stat label="Next">
          {next && gap !== null ? (
            gap < 0.005 ? (
              <>Tied with {next.name}</>
            ) : (
              <>
                {next.name}, <span className="tabular-nums">{fmtUSD(gap)}</span> more a month
              </>
            )
          ) : (
            "-"
          )}
        </Stat>
        <Stat label="Vendors priced at this size">
          <span className="tabular-nums">{plans}</span>
          {spread !== null && spread > 1.05 && (
            <>
              , dearest{" "}
              <span className="tabular-nums">{spread < 10 ? spread.toFixed(1) : Math.round(spread)}x</span>
            </>
          )}
        </Stat>
        <Stat label="Product page">
          <span className="inline-flex items-center gap-1 text-ink group-hover:underline">
            {leader.name}
            <ArrowUpRight size={14} strokeWidth={2} />
          </span>
        </Stat>
      </div>
      {cheaperUncertain && (
        <p className="mt-3 text-xs text-ink-muted">
          {cheaperUncertain.name} {cheaperUncertain.planName} comes to{" "}
          {fmtUSD(cheaperUncertain.usd)}/mo on one reading of a page that can be read more
          than one way, so it is listed below rather than named here.
        </p>
      )}
      {leader.usd === 0 && (
        <p className="mt-3 text-xs text-ink-muted">
          $0 at this size: a free plan&apos;s allowance covers it.
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

function PodiumCard({ row, rank, leaderUSD, mau }: { row: WalletCostRow; rank: number; leaderUSD: number; mau: number }) {
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
          <span className="block truncate text-xs text-ink-faint">
            {row.planName} · {lowerFirst(row.unit)}
          </span>
        </span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="flex flex-wrap gap-1">
          <Uncertain row={row} />
        </span>
        <span className="text-right">
          <span className="block text-xl font-semibold tabular-nums text-ink">
            {fmtUSD(row.usd)}
            <span className="text-xs font-normal text-ink-faint">/mo</span>
          </span>
          <span className="block text-[11px] tabular-nums text-ink-faint">
            {fmtPerUser(row.usd, mau)} a user
            {ratio !== null && ratio >= 1.005 ? ` · ${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}x` : ""}
          </span>
        </span>
      </div>
    </Link>
  );
}

function RankRow({ row, rank, leaderUSD, mau }: { row: WalletCostRow; rank: number; leaderUSD: number; mau: number }) {
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
            {/* The unit wraps instead of truncating: on a phone it is the
                part that explains the order, and "monthly active ..." does
                not. */}
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-ink-faint">
              <span>
                {row.planName} · {lowerFirst(row.unit)}
              </span>
              <Uncertain row={row} />
            </span>
          </span>
        </span>
        <span className="text-right">
          <span className="block whitespace-nowrap font-semibold tabular-nums text-ink">
            {fmtUSD(row.usd)}
            <span className="font-normal text-ink-faint">/mo</span>
          </span>
          <span className="block text-[11px] tabular-nums text-ink-faint">
            {fmtPerUser(row.usd, mau)}
            {ratio !== null && ratio >= 1.005 ? ` · ${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}x` : ""}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** The track is logarithmic: 100 to 1M users is four decades. */
export function countAt(step: number, floor: number, ceiling: number): number {
  const t = Math.min(1, Math.max(0, step / STEPS));
  return floor * Math.pow(ceiling / floor, t);
}

export function stepOf(count: number, floor: number, ceiling: number): number {
  const t = Math.log(count / floor) / Math.log(ceiling / floor);
  return Math.round(Math.min(1, Math.max(0, t)) * STEPS);
}

/** Two significant figures below 1,000, three above: nobody plans for 41,237 users. */
export function roundCount(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  const digits = v < 1000 ? 1 : 2;
  const mag = Math.pow(10, Math.floor(Math.log10(v)) - digits);
  return Math.round(v / mag) * mag;
}

export function fmtCount(v: number): string {
  if (v >= 1e6) return `${trim(v / 1e6)}M`;
  if (v >= 1e3) return `${trim(v / 1e3)}k`;
  return String(Math.round(v));
}

function trim(v: number): string {
  return v
    .toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1");
}

export function fmtUSD(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd)) return "-";
  const cents = Math.round(usd * 100) / 100;
  if (cents === 0) return "$0";
  // To the cent whenever there are cents, as the product tables and the API
  // print: Dfns Pro is $35,000 / 12 = $2,916.67, which this printed $2,917
  // beside a product page saying $2,916.67 (audit 2026-10-30).
  if (Number.isInteger(cents)) return `$${cents.toLocaleString("en-US")}`;
  return `$${cents.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Per-user cost, three significant figures: $0.0274 reads as $0.0274, not <$0.01. */
export function fmtPerUser(usd: number | null, mau: number): string {
  if (usd === null || !Number.isFinite(usd) || mau <= 0) return "-";
  const v = usd / mau;
  if (v === 0) return "$0";
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${Number(v.toPrecision(3))}`;
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
