"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import type { PmVenueRow } from "@/lib/pm-stats";

/**
 * Sortable + searchable venue leaderboard for /prediction-markets.
 * Mirrors the HL cohort leaderboard structure, with PM specific columns:
 * onchain/offchain badge, 30d volume, open interest, active markets,
 * median resolution delay (from pm-resolution-delay bench), p50 API
 * latency (from pm-api-latency bench) and markets above $1M.
 *
 * The data is pure SSR input; this component only handles sort + search
 * state on the client.
 */

type SortKey =
  | "volume30d"
  | "openInterest"
  | "activeMarkets"
  | "medianResolutionDelayMin"
  | "p50ApiLatencyMs"
  | "marketsAbove1m";

export function PmVenuesLeaderboard({ rows }: { rows: PmVenueRow[] }) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("volume30d");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [q, setQ] = useState("");

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
    return [...out].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
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
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search venue..."
          className="text-[12.5px] px-3 py-1.5 rounded-md border border-ink/15 bg-paper focus:outline-none focus:ring-2 focus:ring-teal-500/30 min-w-[180px]"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <Th>Venue</Th>
              <ThSort
                active={sortKey === "volume30d"}
                dir={sortDir}
                onClick={() => setSort("volume30d")}
              >
                Volume 30d
              </ThSort>
              <ThSort
                active={sortKey === "openInterest"}
                dir={sortDir}
                onClick={() => setSort("openInterest")}
              >
                Open Interest
              </ThSort>
              <ThSort
                active={sortKey === "activeMarkets"}
                dir={sortDir}
                onClick={() => setSort("activeMarkets")}
              >
                Active Markets
              </ThSort>
              <ThSort
                active={sortKey === "medianResolutionDelayMin"}
                dir={sortDir}
                onClick={() => setSort("medianResolutionDelayMin")}
              >
                Median resolution
              </ThSort>
              <ThSort
                active={sortKey === "p50ApiLatencyMs"}
                dir={sortDir}
                onClick={() => setSort("p50ApiLatencyMs")}
              >
                p50 API latency
              </ThSort>
              <ThSort
                active={sortKey === "marketsAbove1m"}
                dir={sortDir}
                onClick={() => setSort("marketsAbove1m")}
              >
                Markets &gt;$1M
              </ThSort>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr
                key={r.slug}
                onClick={() => router.push(`/products/${r.slug}`)}
                className="border-t border-ink/5 hover:bg-paper-soft/40 transition-colors cursor-pointer"
              >
                <Td muted mono>
                  {i + 1}
                </Td>
                <Td>
                  <Link
                    href={`/products/${r.slug}`}
                    className="flex items-center gap-2 min-w-0 group"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ProviderLogo slug={r.slug} name={r.name} size={18} />
                    <span className="font-medium text-ink truncate group-hover:underline underline-offset-2">
                      {r.name}
                    </span>
                    <TypeBadge type={r.type} />
                    <ChevronRight
                      size={14}
                      className="text-ink-faint shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    />
                  </Link>
                </Td>
                <Td mono>{fmtUSD(r.volume30d)}</Td>
                <Td mono>{fmtUSD(r.openInterest)}</Td>
                <Td mono>{fmtCount(r.activeMarkets)}</Td>
                <Td mono>{fmtMinutes(r.medianResolutionDelayMin)}</Td>
                <Td mono>{fmtMs(r.p50ApiLatencyMs)}</Td>
                <Td mono>{fmtCount(r.marketsAbove1m)}</Td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={8}
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

function TypeBadge({ type }: { type: "onchain" | "offchain" }) {
  const label = type === "onchain" ? "On chain" : "Off chain";
  return (
    <span
      className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded ${
        type === "onchain"
          ? "bg-teal-500/10 text-teal-700 border border-teal-500/30"
          : "bg-paper-soft text-ink-soft border border-ink/15"
      }`}
      style={{ fontFamily: "var(--font-mono, monospace)" }}
    >
      {label}
    </span>
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

function fmtMinutes(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v < 60) return `${v.toFixed(1)}m`;
  const h = v / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function fmtMs(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v < 1) return `${(v * 1000).toFixed(0)}us`;
  if (v < 1000) return `${v.toFixed(0)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}
