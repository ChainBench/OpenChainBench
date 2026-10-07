"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ProviderLogo } from "@/components/provider-logo";
import { HlSparkline } from "@/components/hl-sparkline";
import { HL_WINDOWS, HL_WINDOW_LABEL } from "@/lib/hl-feed";
import type { HlWindow } from "@/lib/hl-feed";
import type {
  HlCohortRow,
  HlHistoryFrontendCompact,
} from "@/lib/hl-builder-stats";

/**
 * Sortable + searchable leaderboard of every tracked Hyperliquid
 * frontend. Data is passed in from the SSR pass so the initial paint
 * is fully populated (good for SEO and TTFB); the client only handles
 * interaction state.
 *
 * When a `historyBySlug` map is provided the row renders a compact
 * 12-month sparkline in the trend column (matches the parent hub's
 * per-frontend detail page). Slugs missing from the map render an
 * em-dash so builders without a history sample don't blank the column.
 *
 * The timeframe control swaps the revenue/volume/users columns between the
 * three windows the harness publishes. 24h means the last complete UTC feed
 * day rather than a rolling 24 hours, which is why the label says "feed day";
 * every builder is measured on the same day, so the column is comparable.
 * Users do not add across windows (a wallet active on five days is one user
 * over 7d), so the 7d and 30d figures are unions the harness computes, never
 * sums of the 24h column.
 */

/** The three value columns, plus the share column which only exists for 24h. */
type SortKey = "revenue" | "volume" | "users" | "cohortVolumeShare24h";

export function HlCohortLeaderboard({
  rows,
  historyBySlug,
}: {
  rows: HlCohortRow[];
  historyBySlug?: Map<string, HlHistoryFrontendCompact>;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("revenue");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [q, setQ] = useState("");
  const [timeframe, setTimeframe] = useState<HlWindow>("30d");

  // A snapshot written before the per-window fields existed has no byWindow,
  // and the Upstash blob can be up to ten minutes old. Fall back to the flat
  // 30d fields rather than render a table of zeros for one cache cycle.
  const valueOf = (r: HlCohortRow, key: SortKey): number => {
    if (key === "cohortVolumeShare24h") return r.cohortVolumeShare24h;
    const w = r.byWindow?.[timeframe];
    if (w) return w[key];
    return key === "revenue"
      ? r.revenue30d
      : key === "volume"
        ? r.volume30d
        : r.users30d;
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = needle
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(needle) ||
            r.slug.toLowerCase().includes(needle),
        )
      : rows;
    const factor = sortDir === "desc" ? -1 : 1;
    return [...out].sort(
      (a, b) => factor * (valueOf(a, sortKey) - valueOf(b, sortKey)),
    );
    // valueOf closes over `timeframe`, which is listed; it is stable otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortKey, sortDir, q, timeframe]);

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
        <div className="flex items-center gap-3 flex-wrap">
          <p
            className="text-[11px] text-ink-faint"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {filtered.length} of {rows.length} builders
          </p>
          <div
            className="inline-flex rounded-md border border-ink/15 overflow-hidden"
            role="group"
            aria-label="Timeframe"
          >
            {HL_WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setTimeframe(w)}
                aria-pressed={timeframe === w}
                className={
                  "px-2.5 py-1 text-[11px] tabular-nums transition-colors " +
                  (timeframe === w
                    ? "bg-ink text-paper"
                    : "text-ink-soft hover:bg-paper-soft/60")
                }
              >
                {HL_WINDOW_LABEL[w]}
              </button>
            ))}
          </div>
        </div>
        <input
          type="search" aria-label="Search builder…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search builder…"
          className="text-[12.5px] px-3 py-1.5 rounded-md border border-ink/15 bg-paper focus:outline-none focus:ring-2 focus:ring-ink/15 min-w-[180px]"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <Th>Builder</Th>
              <ThSort
                active={sortKey === "revenue"}
                dir={sortDir}
                onClick={() => setSort("revenue")}
              >
                Revenue {HL_WINDOW_LABEL[timeframe]}
              </ThSort>
              <ThSort
                active={sortKey === "volume"}
                dir={sortDir}
                onClick={() => setSort("volume")}
              >
                Volume {HL_WINDOW_LABEL[timeframe]}
              </ThSort>
              <ThSort
                active={sortKey === "users"}
                dir={sortDir}
                onClick={() => setSort("users")}
              >
                Users {HL_WINDOW_LABEL[timeframe]}
              </ThSort>
              <ThSort
                active={sortKey === "cohortVolumeShare24h"}
                dir={sortDir}
                onClick={() => setSort("cohortVolumeShare24h")}
              >
                % cohort 24h
              </ThSort>
              {historyBySlug && <Th>12m trend</Th>}
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const hist = historyBySlug?.get(r.slug);
              // Every cohort builder is a provider on the
              // hyperliquid-frontends bench, so /products/<slug>#hl exists
              // for all of them (the Hyperliquid view degrades gracefully
              // when the history blob lacks the frontend).
              // Unlabeled builder addresses (hex slugs) have no product
              // page by design: render them as text, never as a link.
              const hasDetailPage = !/^0x[a-f0-9]+$/i.test(r.slug);
              return (
                <tr
                  key={r.slug}
                  className="border-t border-ink/5 hover:bg-paper-soft/40 transition-colors"
                >
                  <Td muted mono>
                    {i + 1}
                  </Td>
                  <Td>
                    {hasDetailPage ? (
                      <Link
                        href={`/products/${r.slug}#hl`}
                        className="flex items-center gap-2 min-w-0 hover:underline"
                      >
                        <ProviderLogo slug={r.slug} name={r.name} size={18} />
                        <span className="font-medium text-ink truncate">
                          {r.name}
                        </span>
                      </Link>
                    ) : (
                      <span className="flex items-center gap-2 min-w-0">
                        <ProviderLogo slug={r.slug} name={r.name} size={18} />
                        <span className="font-medium text-ink truncate">
                          {r.name}
                        </span>
                      </span>
                    )}
                  </Td>
                  <Td mono>{fmtUSD(valueOf(r, "revenue"))}</Td>
                  <Td mono>{fmtUSD(valueOf(r, "volume"))}</Td>
                  <Td mono>{fmtCount(valueOf(r, "users"))}</Td>
                  <Td mono>{fmtPct(r.cohortVolumeShare24h)}</Td>
                  {historyBySlug && (
                    <Td>
                      {hist ? (
                        <HlSparkline values={hist.fees} width={160} height={24} />
                      ) : (
                        <span
                          className="text-[11px] text-ink-faint"
                          style={{ fontFamily: "var(--font-mono, monospace)" }}
                        >
                          —
                        </span>
                      )}
                    </Td>
                  )}
                  <Td>
                    {hasDetailPage ? (
                      <Link
                        href={`/products/${r.slug}#hl`}
                        className="text-[11px] text-ink-faint hover:text-ink"
                      >
                        Open →
                      </Link>
                    ) : (
                      <span className="text-[11px] text-ink-faint">—</span>
                    )}
                  </Td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={historyBySlug ? 8 : 7}
                  className="px-3 py-8 text-center text-[12px] text-ink-faint"
                >
                  No builder matches &ldquo;{q}&rdquo;.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
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
          {active ? (dir === "desc" ? "▼" : "▲") : "⇅"}
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

function fmtPct(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0%";
  const pct = v * 100;
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(3)}%`;
}
