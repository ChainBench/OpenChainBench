import Link from "next/link";
import {
  fetchHlBuilderStats,
  fetchHlCohort,
  fetchHlHistory,
  type HlHistoryFrontendCompact,
} from "@/lib/hl-builder-stats";
import { HlBuilderDashboard } from "@/components/hl-builder-dashboard";

/**
 * Hyperliquid frontend view on /products/<slug>, behind the
 * "Hyperliquid" pill. This is the former /hyperliquid/<slug> page folded
 * into the product page (2026-09-17): a frontend like FOMO is also a
 * Solana trading app, a memecoin platform and an app-store listing, so
 * the product page is the one canonical surface and the Hyperliquid
 * numbers are one view on it. /hyperliquid/<slug> now 308s here.
 *
 * Composition top to bottom:
 *   1. Hero: rolling 30d builder fees, first day active, all-time peak
 *   2. HlBuilderDashboard: HyperTracker-parity KPI grid, 30d chart with
 *      biggest-day marker, coin-share donut, user-percentile bar,
 *      milestones, top users
 *   3. Peer group: 5 frontends in the same fees bracket
 *
 * Degrades in steps: no builder stats (Prom unreachable) -> 4-card KPI
 * strip from the history blob; no history entry -> cohort KPIs plus a
 * "history aggregating" note. Never throws, never empties the pill.
 */
export async function HlFrontendSection({
  slug,
  name,
}: {
  slug: string;
  name: string;
}) {
  const [history, cohort, hlStats] = await Promise.all([
    fetchHlHistory(),
    fetchHlCohort(),
    fetchHlBuilderStats(slug),
  ]);
  const frontend = history?.frontends.find((f) => f.slug === slug);
  const cohortRow = cohort?.rows.find((r) => r.slug === slug);
  const displayName = frontend?.name ?? cohortRow?.name ?? name;

  const currentFees =
    cohortRow?.revenue30d ?? (frontend ? lastNonNull(frontend.fees) : hlStats?.revenue30d ?? 0);
  const currentVolume = cohortRow?.volume30d ?? (frontend ? lastNonNull(frontend.volume) : 0);
  const peakFees = frontend ? peakOf(frontend.fees) : 0;
  const firstDay =
    history && frontend
      ? formatFullDate(history.t0 + history.step * 1000 * frontend.firstIdx)
      : null;
  const peers = history && frontend ? pickPeers(history.frontends, frontend, 5) : [];

  return (
    <section id="hl" className="scroll-mt-24 py-10 border-t border-ink/8 first:border-0">
      <header className="mb-8">
        <p className="label-mono text-ink-faint mb-2">Hyperliquid frontend</p>
        <div className="flex items-baseline gap-3">
          <span className="text-4xl font-semibold tabular-nums text-ink">
            {fmtUSDShort(currentFees)}
          </span>
          <span className="text-sm text-ink-soft">rolling 30d builder fees</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-faint">
          {firstDay && (
            <span>
              First day active: <span className="text-ink-soft">{firstDay}</span>
            </span>
          )}
          {peakFees > 0 && (
            <span>
              Peak fees (30d):{" "}
              <span className="text-ink-soft tabular-nums">{fmtUSDShort(peakFees)}</span>
            </span>
          )}
          {!frontend && cohortRow && (
            <>
              <span>
                Volume 30d:{" "}
                <span className="text-ink-soft tabular-nums">{fmtUSDShort(cohortRow.volume30d)}</span>
              </span>
              <span>
                Users 30d:{" "}
                <span className="text-ink-soft tabular-nums">{cohortRow.users30d.toLocaleString()}</span>
              </span>
            </>
          )}
        </div>
      </header>

      {hlStats ? (
        <HlBuilderDashboard stats={hlStats} name={displayName} />
      ) : frontend || cohortRow ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-10">
          <Kpi label="Fees 30d" value={fmtUSDShort(currentFees)} />
          <Kpi label="Volume 30d" value={fmtUSDShort(currentVolume)} />
          {firstDay ? (
            <Kpi label="First day active" value={firstDay} />
          ) : cohortRow ? (
            <Kpi label="Users 30d" value={cohortRow.users30d.toLocaleString()} />
          ) : null}
          {peakFees > 0 ? (
            <Kpi label="Peak fees (all-time 30d)" value={fmtUSDShort(peakFees)} />
          ) : cohortRow ? (
            <Kpi
              label="Cohort share 24h"
              value={`${(cohortRow.cohortVolumeShare24h * 100).toFixed(2)}%`}
            />
          ) : null}
        </div>
      ) : null}

      {!frontend && (
        <div className="rounded-lg border border-ink/10 bg-paper-soft/40 p-5 max-w-2xl mb-10">
          <h3 className="text-lg font-semibold text-ink mb-2">12-month history aggregating</h3>
          <p className="text-sm text-ink-soft">
            {displayName} is tracked on the Hyperliquid builder cohort. The
            12-month history, peak fees and peer group appear here as soon
            as the next data sweep completes. In the meantime, the{" "}
            <Link href="/hyperliquid" className="underline hover:no-underline">
              Hyperliquid frontends grid
            </Link>{" "}
            has the live ranking.
          </p>
        </div>
      )}

      {peers.length > 0 && (
        <div>
          <h3 className="text-2xl font-semibold mb-3">Peer group</h3>
          <p className="text-sm text-ink-soft mb-4 max-w-2xl">
            Frontends in the same order-of-magnitude bracket for current 30-day fees.
          </p>
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {peers.map((p) => (
              <li key={p.slug}>
                <Link
                  href={`/products/${p.slug}#hl`}
                  className="flex flex-col rounded-lg border border-ink/10 bg-paper p-3 hover:border-ink/30 hover:bg-paper-soft/40"
                >
                  <span className="truncate text-sm font-semibold text-ink">{p.name}</span>
                  <span className="mt-1 text-base font-semibold tabular-nums text-ink">
                    {fmtUSDShort(lastNonNull(p.fees))}
                  </span>
                  <span
                    className="mt-0.5 text-[10px] text-ink-faint"
                    style={{ fontFamily: "var(--font-mono, monospace)" }}
                  >
                    Fees 30d
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-8 text-[11px] text-ink-faint italic">
        Source: Hyperliquid&apos;s public per-builder daily fills feed, last
        complete UTC day. Same 30d gauges as the{" "}
        <Link href="/hyperliquid" className="underline hover:no-underline">
          /hyperliquid
        </Link>{" "}
        hub; moves once a day when the feed publishes.
      </p>
    </section>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink/10 bg-paper p-4">
      <p
        className="label-mono text-[10px] text-ink-faint"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {label}
      </p>
      <p className="mt-1.5 text-lg font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}

function lastNonNull(arr: (number | null)[]): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return 0;
}

function peakOf(arr: (number | null)[]): number {
  let m = 0;
  for (const v of arr) {
    if (v !== null && v > m) m = v;
  }
  return m;
}

/** Up to `count` peers in the same order-of-magnitude bracket as `me`,
 *  by distance in log space, then name. */
function pickPeers(
  all: HlHistoryFrontendCompact[],
  me: HlHistoryFrontendCompact,
  count: number,
): HlHistoryFrontendCompact[] {
  const myFees = lastNonNull(me.fees);
  if (myFees <= 0) return [];
  const myLog = Math.log10(myFees);
  const scored = all
    .filter((f) => f.slug !== me.slug)
    .map((f) => {
      const v = lastNonNull(f.fees);
      if (v <= 0) return null;
      return { f, dist: Math.abs(Math.log10(v) - myLog) };
    })
    .filter((x): x is { f: HlHistoryFrontendCompact; dist: number } => x !== null);
  scored.sort((a, b) => (a.dist !== b.dist ? a.dist - b.dist : a.f.name.localeCompare(b.f.name)));
  return scored.slice(0, count).map((x) => x.f);
}

function fmtUSDShort(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatFullDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS_FULL[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
