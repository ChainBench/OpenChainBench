"use client";

import { useMemo, useState } from "react";
import { HlCohortLeaderboard } from "@/components/hl-cohort-leaderboard";
import { HlHip3Leaderboard } from "@/components/hl-hip3-leaderboard";
import type {
  HlCohortSummary,
  HlHip3Summary,
  HlHistoryFrontendCompact,
  HlHistorySummary,
} from "@/lib/hl-builder-stats";

/**
 * Tab wrapper for the `/hyperliquid` hub. Swaps between the frontends
 * cohort (104 builder-code routers) and the HIP-3 deployer cohort
 * (markets-deployment-permissionless side). Both cohorts are fetched
 * server-side and passed in as props so the initial paint stays SSR
 * (good for SEO of both data sets).
 *
 * Each tab swaps the Summary row AND the leaderboard — two complete
 * stories sharing one hero/URL, since they describe complementary
 * revenue streams on the same chain.
 */

type Tab = "frontends" | "hip3";

export function HlHubTabs({
  frontends,
  hip3,
  history,
}: {
  frontends: HlCohortSummary | null;
  hip3: HlHip3Summary | null;
  history?: HlHistorySummary | null;
}) {
  const initialTab: Tab =
    frontends && frontends.rows.length > 0 ? "frontends" : "hip3";
  const [tab, setTab] = useState<Tab>(initialTab);

  const frontendsCount = frontends?.rows.length ?? 0;
  const hip3Count = hip3?.rows.length ?? 0;

  // Index the compact history array by slug once so the leaderboard rows
  // can pull their sparkline series in O(1). Rebuilds only when the blob
  // changes (server-side refresh cycle) so client-side sort/filter stays
  // free of the O(rows × frontends) scan.
  const historyBySlug = useMemo(() => {
    if (!history) return undefined;
    const m = new Map<string, HlHistoryFrontendCompact>();
    for (const f of history.frontends) m.set(f.slug, f);
    return m;
  }, [history]);

  return (
    <>
      <div
        className="inline-flex rounded-lg border border-ink/15 p-1 bg-paper-soft/40 mb-4"
        role="tablist"
        aria-label="Hyperliquid cohort"
      >
        <TabButton
          active={tab === "frontends"}
          onClick={() => setTab("frontends")}
          count={frontendsCount}
          disabled={frontendsCount === 0}
        >
          Frontends
        </TabButton>
        <TabButton
          active={tab === "hip3"}
          onClick={() => setTab("hip3")}
          count={hip3Count}
          disabled={hip3Count === 0}
        >
          HIP-3 dexes
        </TabButton>
      </div>

      {tab === "frontends" && frontends && (
        <FrontendsView data={frontends} historyBySlug={historyBySlug} />
      )}
      {tab === "hip3" && hip3 && <Hip3View data={hip3} />}
    </>
  );
}

function TabButton({
  children,
  active,
  count,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  active: boolean;
  count: number;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-colors flex items-center gap-2 ${
        active
          ? "bg-paper text-ink shadow-sm"
          : "text-ink-soft hover:text-ink"
      } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      {children}
      <span
        className={`text-[10.5px] ${active ? "text-ink-faint" : "text-ink-faint"}`}
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {count}
      </span>
    </button>
  );
}

function FrontendsView({
  data,
  historyBySlug,
}: {
  data: HlCohortSummary;
  historyBySlug?: Map<string, HlHistoryFrontendCompact>;
}) {
  return (
    <>
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <SummaryCard
          label="Tracked builders"
          value={data.rows.length.toLocaleString("en-US")}
          accent="#9d65ff"
        />
        <SummaryCard
          label="Cohort revenue 30d"
          value={fmtUSD(data.totalRevenue30d)}
        />
        <SummaryCard
          label="Cohort volume 30d"
          value={fmtUSD(data.totalVolume30d)}
        />
        <SummaryCard
          label="Cumulative users 30d"
          value={fmtCount(data.totalUsers30d)}
          tip="Sum across builders. A wallet active on two frontends is counted twice (HyperTracker uses the same convention)."
        />
      </section>
      <HlCohortLeaderboard rows={data.rows} historyBySlug={historyBySlug} />
    </>
  );
}

function Hip3View({ data }: { data: HlHip3Summary }) {
  return (
    <>
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <SummaryCard
          label="Live deployers"
          value={data.rows.length.toLocaleString("en-US")}
          accent="#ff8a3d"
        />
        <SummaryCard
          label="Cohort fees 24h"
          value={fmtUSD(data.totalFees24h)}
        />
        <SummaryCard
          label="Cohort fees 30d"
          value={fmtUSD(data.totalFees30d)}
        />
        <SummaryCard
          label="Cohort volume 24h"
          value={fmtUSD(data.totalVolume24h)}
        />
      </section>
      <HlHip3Leaderboard rows={data.rows} />
    </>
  );
}

function SummaryCard({
  label,
  value,
  accent,
  tip,
}: {
  label: string;
  value: string;
  accent?: string;
  tip?: string;
}) {
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15"
      title={tip}
    >
      <p
        className="label-mono text-[10px] text-ink-faint mb-1 flex items-center gap-1.5"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {accent && (
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: accent }}
          />
        )}
        {label}
      </p>
      <p className="text-lg sm:text-2xl font-semibold tabular-nums leading-tight">
        {value}
      </p>
    </div>
  );
}

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtCount(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}
