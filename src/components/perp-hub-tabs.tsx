"use client";

import { useState } from "react";
import { PerpVenuesLeaderboard } from "@/components/perp-venues-leaderboard";
import { PerpByAssetTable } from "@/components/perp-by-asset-table";
import type { PerpAssetRow, PerpCohortSummary } from "@/lib/perp-stats";

/**
 * Tab wrapper for the /perps hub. Mirrors PmHubTabs: pills that swap
 * the panel underneath without a second network round trip. Both the
 * cohort and the per-asset matrix are fetched server side and passed
 * in as props; the client owns only the tab state.
 *
 * The "By asset" tab degrades to a "data warming up" placeholder when
 * the harness has not yet published the per-asset funding matrix, so
 * the tab is always selectable and never throws.
 */

type Tab = "venues" | "by-asset";

export function PerpHubTabs({
  cohort,
  byAsset,
}: {
  cohort: PerpCohortSummary;
  byAsset: PerpAssetRow[];
}) {
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
          count={byAsset.length}
        >
          By asset
        </TabButton>
      </div>

      {tab === "venues" && <PerpVenuesLeaderboard rows={cohort.venues} />}
      {tab === "by-asset" && <PerpByAssetTable rows={byAsset} />}
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
