"use client";

import { useState } from "react";
import { PerpVenuesLeaderboard } from "@/components/perp-venues-leaderboard";
import type { PerpCohortSummary } from "@/lib/perp-stats";

/**
 * Tab wrapper for the /perps hub. Mirrors PmHubTabs: pills that swap
 * the panel underneath without a second network round trip. The cohort
 * is fetched server side and passed in as one prop; the client owns
 * only the tab state.
 *
 * For v1 only the "DEX venues" tab is fully wired. The "By asset" tab
 * is a placeholder that hints at the planned per-asset cross-venue
 * breakdown (BTC, ETH, SOL volumes, OI, funding). Tab is selectable so
 * SEO crawlers see both pill labels in the markup.
 */

type Tab = "venues" | "by-asset";

export function PerpHubTabs({ cohort }: { cohort: PerpCohortSummary }) {
  const [tab, setTab] = useState<Tab>("venues");

  const venuesCount = cohort.venues.length;

  return (
    <>
      <div
        className="inline-flex rounded-lg border border-ink/15 p-1 bg-paper-soft/40 mb-4"
        role="tablist"
        aria-label="Perpetuals cohort"
      >
        <TabButton
          active={tab === "venues"}
          onClick={() => setTab("venues")}
          count={venuesCount}
        >
          DEX venues
        </TabButton>
        <TabButton
          active={tab === "by-asset"}
          onClick={() => setTab("by-asset")}
          count={3}
        >
          By asset
        </TabButton>
      </div>

      {tab === "venues" && <PerpVenuesLeaderboard rows={cohort.venues} />}
      {tab === "by-asset" && (
        <div className="mt-6 card-soft rounded-xl border border-ink/10 p-8 text-center">
          <p className="text-[12.5px] text-ink-faint italic">
            Per-asset breakdown (BTC, ETH, SOL volume, open interest and
            funding spread across the cohort) ships in the next iteration.
            Until then, the venue page (click a row above) carries the
            per-asset all-in fee and funding from benchmarks perp-fees
            and perp-funding.
          </p>
        </div>
      )}
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
        className="text-[10.5px] text-ink-faint"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {count}
      </span>
    </button>
  );
}
