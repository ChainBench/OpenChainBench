"use client";

import { useState } from "react";
import { PerpVenuesLeaderboard } from "@/components/perp-venues-leaderboard";
import { NOTIONAL_NOT_COMPARABLE } from "@/lib/perp-notional-scope";
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
type VenueKind = "measured" | "cex" | "all";

export function PerpHubTabs({
  cohort,
  byAsset,
}: {
  cohort: PerpCohortSummary;
  byAsset: PerpAssetRow[];
}) {
  const [tab, setTab] = useState<Tab>("venues");
  // Venue type behind the leaderboard, like the Access selector on /rpc:
  // measured rows (DEX and the regulated Kalshi book) by default, the
  // centralised reference (venue-reported via CoinGecko) on request, or
  // everything on one board.
  const [kind, setKind] = useState<VenueKind>("measured");
  const shown = cohort.venues.filter((v) =>
    kind === "all" ? true : kind === "cex" ? v.venueType === "cex" : v.venueType !== "cex",
  );
  // The table sorts by 30-day volume, so a venue whose notional is not the
  // cohort's quantity takes rank 1 simply by being leveraged. That is what put
  // Papertrade above Hyperliquid at $1267B against $161B, on two markets, under
  // a headline naming Hyperliquid. The lede and the Markdown view already
  // exclude it; this is the surface that did not.
  const ranked = shown.filter((v) => !NOTIONAL_NOT_COMPARABLE.has(v.slug));
  const apart = shown.filter((v) => NOTIONAL_NOT_COMPARABLE.has(v.slug));
  const measuredCount = cohort.venues.filter((v) => v.venueType !== "cex").length;
  const cexCount = cohort.venues.length - measuredCount;

  const venuesCount = shown.length;

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

      {tab === "venues" && cexCount > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="label-mono text-ink-faint text-[10px]" style={{ fontFamily: "var(--font-mono, monospace)" }}>
            Venue type
          </span>
          {(
            [
              ["measured", `DEX and regulated, measured (${measuredCount})`],
              ["cex", `Centralised, venue-reported (${cexCount})`],
              ["all", `All (${cohort.venues.length})`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={`rounded-full border px-3 py-1 ${kind === k ? "border-teal-500/40 bg-teal-500/10 text-ink" : "border-ink/10 text-ink-soft hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
          {kind !== "measured" && (
            <span className="text-ink-faint">
              CEX volume, open interest and market counts are what each venue reports to CoinGecko, not an OpenChainBench measurement; funding is measured.
            </span>
          )}
        </div>
      )}
      {tab === "venues" && (
        <>
          <PerpVenuesLeaderboard rows={ranked} />
          {apart.length > 0 && (
            <section className="mt-8">
              <h3 className="text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                Measured, not ranked on volume
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-ink-muted">
                Notional turnover on a single house LP at up to 1000x leverage
                is not the quantity the rows above measure, so these venues are
                excluded from the 30-day volume ranking and from the cohort
                volume total. Their open interest is included: a snapshot of
                open positions is the same measurement everywhere.
              </p>
              <div className="mt-3">
                <PerpVenuesLeaderboard rows={apart} />
              </div>
            </section>
          )}
        </>
      )}
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
