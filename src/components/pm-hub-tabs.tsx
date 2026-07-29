"use client";

import { useState } from "react";
import { PmVenuesLeaderboard } from "@/components/pm-venues-leaderboard";
import { PmDataFeedsLeaderboard } from "@/components/pm-data-feeds-leaderboard";
import type { PmCohortSummary } from "@/lib/pm-stats";

/**
 * Tab wrapper for the /prediction-markets hub. Mirrors HlHubTabs: two
 * pills that swap the leaderboard underneath without a second network
 * round trip. The cohort is fetched server side and passed in as one
 * prop; the client owns only the tab state.
 *
 * Default tab is "Venues" because that's the page's headline cohort.
 * If the venue dataset is empty (harness not yet live) we still default
 * to Venues so the empty state messaging stays consistent with the
 * page hero.
 */

type Tab = "venues" | "feeds";

export function PmHubTabs({ cohort }: { cohort: PmCohortSummary }) {
  const [tab, setTab] = useState<Tab>("venues");

  const venuesCount = cohort.venues.length;
  const feedsCount = cohort.dataFeeds.length;

  return (
    <>
      <div
        className="inline-flex rounded-lg border border-ink/15 p-1 bg-paper-soft/40 mb-4"
        role="tablist"
        aria-label="Prediction markets cohort"
      >
        <TabButton
          active={tab === "venues"}
          onClick={() => setTab("venues")}
          count={venuesCount}
        >
          Venues
        </TabButton>
        {feedsCount > 0 && (
          <TabButton
            active={tab === "feeds"}
            onClick={() => setTab("feeds")}
            count={feedsCount}
          >
            Data feeds
          </TabButton>
        )}
      </div>

      {tab === "venues" && <PmVenuesLeaderboard rows={cohort.venues} />}
      {tab === "feeds" && feedsCount > 0 && <PmDataFeedsLeaderboard rows={cohort.dataFeeds} />}
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
