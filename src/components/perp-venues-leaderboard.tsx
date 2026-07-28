"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import type { PerpVenueRow } from "@/lib/perp-stats";

/**
 * Sortable + searchable venue leaderboard for /perps. Mirrors the PM
 * leaderboard structure with perp-specific columns: chain badge, 30d
 * volume, open interest, fees 30d, all-in fee (from perp-fees bench),
 * funding 24h (from perp-funding bench), volume / OI ratio (color
 * banded), active markets, health.
 *
 * The data is pure SSR input; this component only handles sort + search
 * state on the client.
 */

type SortKey =
  | "volume30d"
  | "openInterest"
  | "fees30d"
  | "allInFeeBpsEth"
  | "funding24hBpsEth"
  | "volOiRatio"
  | "activeMarkets"
  | "health";

export function PerpVenuesLeaderboard({ rows }: { rows: PerpVenueRow[] }) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("volume30d");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [q, setQ] = useState("");

  const ratio = (r: PerpVenueRow) =>
    r.volume30d != null && r.openInterest != null && r.openInterest > 0
      ? r.volume30d / r.openInterest
      : null;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = needle
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(needle) ||
            r.slug.toLowerCase().includes(needle) ||
            r.chain.toLowerCase().includes(needle),
        )
      : rows;
    const factor = sortDir === "desc" ? -1 : 1;
    return [...out].sort((a, b) => {
      const av = sortKey === "volOiRatio" ? ratio(a) : a[sortKey];
      const bv = sortKey === "volOiRatio" ? ratio(b) : b[sortKey];
      // Nulls always sink under either sort direction so a venue with
      // no data never claims rank #1.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return factor * (av - bv);
    });
  }, [rows, sortKey, sortDir, q]);

  const setSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  return (
    <div className="mt-6 card-soft rounded-xl border border-ink/10">
      <div className="p-3 sm:p-4 border-b border-ink/8 flex items-center justify-between gap-3 flex-wrap">
        <p
          className="text-[11px] text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {filtered.length} of {rows.length} venues
        </p>
        <input
          type="search" aria-label="Search venue or chain..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search venue or chain..."
          className="text-[12.5px] px-3 py-1.5 rounded-md border border-ink/15 bg-paper focus:outline-none focus:ring-2 focus:ring-teal-500/30 min-w-[180px]"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <Th>Venue</Th>
              <Th>Chain</Th>
              <ThSort
                active={sortKey === "volume30d"}
                dir={sortDir}
                onClick={() => setSort("volume30d")}
              >
                Vol 30d
              </ThSort>
              <ThSort
                active={sortKey === "openInterest"}
                dir={sortDir}
                onClick={() => setSort("openInterest")}
              >
                OI
              </ThSort>
              <ThSort
                active={sortKey === "fees30d"}
                dir={sortDir}
                onClick={() => setSort("fees30d")}
              >
                Fees 30d
              </ThSort>
              <ThSort
                active={sortKey === "allInFeeBpsEth"}
                dir={sortDir}
                onClick={() => setSort("allInFeeBpsEth")}
              >
                All-in fee (10x ETH)
              </ThSort>
              <ThSort
                active={sortKey === "funding24hBpsEth"}
                dir={sortDir}
                onClick={() => setSort("funding24hBpsEth")}
              >
                Funding ETH 24h
              </ThSort>
              <ThSort
                active={sortKey === "volOiRatio"}
                dir={sortDir}
                onClick={() => setSort("volOiRatio")}
              >
                Vol/OI
              </ThSort>
              <ThSort
                active={sortKey === "activeMarkets"}
                dir={sortDir}
                onClick={() => setSort("activeMarkets")}
              >
                Markets
              </ThSort>
              <ThSort
                active={sortKey === "health"}
                dir={sortDir}
                onClick={() => setSort("health")}
              >
                Health
              </ThSort>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              // GMX v2's product slug is "gmx"; all others match cohort slug.
              const productHref =
                r.slug === "gmx-v2" ? "/perp/gmx" : `/perp/${r.slug}`;
              const vor = ratio(r);
              return (
                <tr
                  key={r.slug}
                  onClick={() => router.push(productHref)}
                  className="border-t border-ink/5 hover:bg-paper-soft/40 transition-colors cursor-pointer"
                >
                  <Td muted mono>
                    {i + 1}
                  </Td>
                  <Td>
                    <Link
                      href={productHref}
                      className="flex items-center gap-2 min-w-0 group"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ProviderLogo
                        slug={r.slug === "gmx-v2" ? "gmx" : r.slug}
                        name={r.name}
                        size={18}
                      />
                      <span className="font-medium text-ink truncate group-hover:underline underline-offset-2">
                        {r.name}
                      </span>
                      <AgeBadge ts={r.lastRefreshUnix} />
                      <ChevronRight
                        size={14}
                        className="text-ink-faint shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </Link>
                  </Td>
                  <Td muted>{r.chain}</Td>
                  <Td mono>{fmtUSD(r.volume30d)}</Td>
                  <Td mono>{fmtUSD(r.openInterest)}</Td>
                  <Td mono>{fmtUSD(r.fees30d)}</Td>
                  <Td mono>{fmtBps(r.allInFeeBpsEth)}</Td>
                  <Td mono>{fmtBpsSigned(r.funding24hBpsEth)}</Td>
                  <VolOiCell ratio={vor} />
                  <Td mono>{fmtCount(r.activeMarkets)}</Td>
                  <Td mono>{fmtPct(r.health)}</Td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={11}
                  className="px-3 py-8 text-center text-[12px] text-ink-faint"
                >
                  No venue matches &ldquo;{q}&rdquo;.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Tiny freshness pill that flags stale rows on the leaderboard. Hidden
 * when the harness has not published a refresh stamp (ts === null) or
 * when the row is younger than 2 minutes (within one Prom scrape).
 * Amber between 2 and 10 minutes, red beyond. Renders inline with the
 * venue name so the operator sees freeze/downtime at a glance without
 * scanning a sidecar column.
 */
function AgeBadge({ ts }: { ts: number | null }) {
  // Subscribe to a 30s wall-clock tick via `useSyncExternalStore`. The
  // server snapshot returns null, which keeps SSR output empty and
  // sidesteps any hydration mismatch from server-vs-client clock skew.
  // The client subscription pushes a fresh `Date.now()` every 30s and
  // satisfies React's react-hooks/set-state-in-effect rule because no
  // setState ever runs inside an effect body.
  const nowSec = useSyncExternalStore(
    subscribeWallClock,
    getClientNowSec,
    getServerNowSec,
  );
  if (nowSec == null || ts == null || !Number.isFinite(ts)) return null;
  const ageSec = nowSec - ts;
  if (ageSec < 120) return null;
  const ageMin = Math.floor(ageSec / 60);
  const stale = ageSec >= 600;
  const iso = new Date(ts * 1000).toISOString();
  const label = stale ? `${ageMin}m stale` : `${ageMin}m ago`;
  const color = stale ? "text-red-500" : "text-amber-500";
  return (
    <span
      className={`label-mono text-[9.5px] uppercase tracking-wide shrink-0 ${color}`}
      style={{ fontFamily: "var(--font-mono, monospace)" }}
      title={`Data last refreshed by harness at ${iso}`}
    >
      {label}
    </span>
  );
}

/**
 * Tiny wall-clock store consumed by AgeBadge through
 * `useSyncExternalStore`. Updates every 30 seconds; one shared
 * setInterval covers every mounted badge so a hundred rows do not
 * spin up a hundred timers. Returns null on the server so SSR output
 * stays free of clock-dependent text.
 */
let wallClockNowSec = Math.floor(Date.now() / 1000);
const wallClockListeners = new Set<() => void>();
let wallClockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeWallClock(cb: () => void): () => void {
  wallClockListeners.add(cb);
  if (wallClockTimer == null && typeof window !== "undefined") {
    wallClockTimer = setInterval(() => {
      wallClockNowSec = Math.floor(Date.now() / 1000);
      for (const fn of wallClockListeners) fn();
    }, 30_000);
  }
  return () => {
    wallClockListeners.delete(cb);
    if (wallClockListeners.size === 0 && wallClockTimer != null) {
      clearInterval(wallClockTimer);
      wallClockTimer = null;
    }
  };
}

function getClientNowSec(): number {
  return wallClockNowSec;
}

function getServerNowSec(): null {
  return null;
}

function VolOiCell({ ratio }: { ratio: number | null }) {
  if (ratio == null || !Number.isFinite(ratio)) {
    return <Td mono>...</Td>;
  }
  // Color bands: <80x normal (teal), 80-300x elevated (amber), >300x flag (red).
  // Loosened from the original 50/200 thresholds because zero-fee venues
  // (Lighter, ~115x today) and MM-heavy order books legitimately churn
  // their OI multiple times per day without it being wash-traded. Only
  // sustained ratios above 300x warrant a visual flag now.
  const band =
    ratio < 80
      ? { fg: "text-teal-700", bg: "bg-teal-500/10", border: "border-teal-500/30" }
      : ratio <= 300
        ? { fg: "text-amber-700", bg: "bg-amber-500/10", border: "border-amber-500/30" }
        : { fg: "text-red-700", bg: "bg-red-500/10", border: "border-red-500/30" };
  return (
    <td
      className="px-3 py-2 tabular-nums"
      style={{ fontFamily: "var(--font-mono, monospace)" }}
      title={
        ratio < 80
          ? "Vol / OI under 80x is typical for an active order-book venue."
          : ratio <= 300
            ? "Vol / OI above 80x means high churn, common for zero-fee venues like Lighter or MM-heavy books running incentive programs."
            : "Vol / OI above 300x typically indicates wash trading and is worth a closer look."
      }
    >
      <span
        className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded border ${band.fg} ${band.bg} ${band.border}`}
      >
        {ratio < 10
          ? `${ratio.toFixed(1)}x`
          : `${Math.round(ratio).toLocaleString("en-US")}x`}
      </span>
    </td>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      className="px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide text-ink-faint"
      style={{ fontFamily: "var(--font-mono, monospace)" }}
    >
      {children}
    </th>
  );
}

function ThSort({
  children,
  active,
  dir,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th
      className={`px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide cursor-pointer select-none ${
        active ? "text-ink" : "text-ink-faint hover:text-ink"
      }`}
      style={{ fontFamily: "var(--font-mono, monospace)" }}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <span className="text-[9px]">
          {active ? (dir === "desc" ? "v" : "^") : "::"}
        </span>
      </span>
    </th>
  );
}

function Td({
  children,
  mono,
  muted,
}: {
  children: React.ReactNode;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={`px-3 py-2 tabular-nums ${muted ? "text-ink-faint" : ""}`}
      style={mono ? { fontFamily: "var(--font-mono, monospace)" } : undefined}
    >
      {children}
    </td>
  );
}

function fmtUSD(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtCount(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

function fmtBps(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (Math.abs(v) >= 100) return `${v.toFixed(0)} bps`;
  return `${v.toFixed(1)} bps`;
}

function fmtBpsSigned(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  const sign = v > 0 ? "+" : "";
  if (Math.abs(v) >= 100) return `${sign}${v.toFixed(0)} bps`;
  return `${sign}${v.toFixed(1)} bps`;
}

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  const pct = v > 1.5 ? v : v * 100;
  if (pct >= 100) return "100%";
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}
