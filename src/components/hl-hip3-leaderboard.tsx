"use client";

import { useMemo, useState } from "react";
import { ProviderLogo } from "@/components/provider-logo";
import type { HlHip3Row } from "@/lib/hl-builder-stats";

/**
 * Sortable leaderboard of HIP-3 builder-deployed dexes on Hyperliquid.
 * Twin of HlCohortLeaderboard but with the HIP-3-specific columns
 * (fees / volume / users at 24h-7d-30d + markets + effective fee bps).
 *
 * Data comes from a single SSR pass (fetchHlHip3Cohort), the client
 * only handles sort + search interactions.
 */

type SortKey =
  | "fees24h"
  | "fees7d"
  | "fees30d"
  | "volume24h"
  | "users24h"
  | "markets24h"
  | "effectiveFeeBps";

export function HlHip3Leaderboard({ rows }: { rows: HlHip3Row[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("fees24h");
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
    return [...out].sort((a, b) => factor * (a[sortKey] - b[sortKey]));
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
          {filtered.length} of {rows.length} dexes
        </p>
        <input
          type="search" aria-label="Search dex…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search dex…"
          className="text-[12.5px] px-3 py-1.5 rounded-md border border-ink/15 bg-paper focus:outline-none focus:ring-2 focus:ring-ink/15 min-w-[180px]"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <Th>Dex</Th>
              <ThSort
                active={sortKey === "fees24h"}
                dir={sortDir}
                onClick={() => setSort("fees24h")}
              >
                Fees 24h
              </ThSort>
              <ThSort
                active={sortKey === "fees7d"}
                dir={sortDir}
                onClick={() => setSort("fees7d")}
              >
                Fees 7d
              </ThSort>
              <ThSort
                active={sortKey === "fees30d"}
                dir={sortDir}
                onClick={() => setSort("fees30d")}
              >
                Fees 30d
              </ThSort>
              <ThSort
                active={sortKey === "volume24h"}
                dir={sortDir}
                onClick={() => setSort("volume24h")}
              >
                Volume 24h
              </ThSort>
              <ThSort
                active={sortKey === "users24h"}
                dir={sortDir}
                onClick={() => setSort("users24h")}
              >
                Users 24h
              </ThSort>
              <ThSort
                active={sortKey === "markets24h"}
                dir={sortDir}
                onClick={() => setSort("markets24h")}
              >
                Markets
              </ThSort>
              <ThSort
                active={sortKey === "effectiveFeeBps"}
                dir={sortDir}
                onClick={() => setSort("effectiveFeeBps")}
              >
                Eff. fee bps
              </ThSort>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr
                key={r.slug}
                className="border-t border-ink/5 hover:bg-paper-soft/40 transition-colors"
              >
                <Td muted mono>
                  {i + 1}
                </Td>
                <Td>
                  <span className="flex items-center gap-2 min-w-0">
                    <ProviderLogo slug={r.slug} name={r.name} size={18} />
                    <span className="font-medium text-ink truncate">
                      {r.name}
                    </span>
                    <span
                      className="text-[10px] text-ink-faint shrink-0"
                      style={{ fontFamily: "var(--font-mono, monospace)" }}
                    >
                      {r.slug}:*
                    </span>
                  </span>
                </Td>
                <Td mono>{fmtUSD(r.fees24h)}</Td>
                <Td mono>{fmtUSD(r.fees7d)}</Td>
                <Td mono>{fmtUSD(r.fees30d)}</Td>
                <Td mono>{fmtUSD(r.volume24h)}</Td>
                <Td mono>{fmtCount(r.users24h)}</Td>
                <Td mono>{fmtCount(r.markets24h)}</Td>
                <Td mono>{fmtBps(r.effectiveFeeBps)}</Td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="px-3 py-8 text-center text-[12px] text-ink-faint"
                >
                  No dex matches &ldquo;{q}&rdquo;.
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

function fmtBps(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0 bps";
  return `${v.toFixed(2)} bps`;
}
