"use client";

import { useMemo, useState } from "react";
import type { PmTopMarket } from "@/lib/pm-venue-data";

/**
 * Top 10 markets sortable table for the venue deep-dive section. Each row
 * is a Link to the venue's market URL (gamma-api gives us the slug, the
 * fetcher pre-builds the absolute URL).
 *
 * Sorting is local React state; we keep the original ordering as default
 * because gamma already pre-sorts by volume24hr desc, which is what
 * 99% of visitors actually want.
 */

type SortKey = "volume" | "oi" | "endDate" | "probability";

export function PmTopMarketsTable({
  markets,
  venueLabel,
}: {
  markets: PmTopMarket[] | null;
  venueLabel: string;
}) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    if (!markets) return [];
    if (sortKey === null) return markets;
    const copy = [...markets];
    copy.sort((a, b) => {
      const av = readSortField(a, sortKey);
      const bv = readSortField(b, sortKey);
      // Nulls sink to the bottom in both directions to avoid the table
      // suddenly leading with "End date: -" when the user clicks once.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return copy;
  }, [markets, sortKey, sortDir]);

  if (!markets || markets.length === 0) {
    return (
      <div className="card-soft rounded-xl p-6 border border-ink/10 text-sm text-ink-faint italic">
        Top markets feed not live yet for {venueLabel}.
      </div>
    );
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  return (
    <div className="card-soft rounded-xl border border-ink/10 overflow-hidden">
      <div className="px-4 sm:px-5 pt-4 pb-2">
        <p
          className="label-mono text-[10px] text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          Top markets · 24h
        </p>
        <p className="text-sm text-ink-faint mt-0.5">
          Sorted by 24h volume on {venueLabel}. Click a column to re-sort.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-paper-soft/60">
            <tr className="text-left text-[11px] text-ink-faint uppercase tracking-wide">
              <Th>Market</Th>
              <Th>Category</Th>
              <Th>End</Th>
              <ThButton
                active={sortKey === "volume"}
                dir={sortDir}
                onClick={() => toggleSort("volume")}
                align="right"
              >
                24h Vol
              </ThButton>
              <ThButton
                active={sortKey === "oi"}
                dir={sortDir}
                onClick={() => toggleSort("oi")}
                align="right"
              >
                OI
              </ThButton>
              <ThButton
                active={sortKey === "probability"}
                dir={sortDir}
                onClick={() => toggleSort("probability")}
                align="right"
              >
                Prob.
              </ThButton>
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr
                key={m.slug}
                className="border-t border-ink/8 hover:bg-paper-soft/40 transition-colors"
              >
                <td className="px-4 py-2.5 max-w-[320px]">
                  <a
                    href={m.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink hover:underline line-clamp-1"
                  >
                    {m.question}
                  </a>
                </td>
                <td className="px-4 py-2.5">
                  <CategoryPill category={m.category} />
                </td>
                <td
                  className="px-4 py-2.5 text-ink-soft tabular-nums whitespace-nowrap"
                  style={{ fontFamily: "var(--font-mono, monospace)" }}
                >
                  {fmtEndDate(m.endDate)}
                </td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums">
                  {fmtUSD(m.volume24h)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">
                  {m.openInterest != null ? fmtUSD(m.openInterest) : "-"}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {m.probability != null
                    ? `${(m.probability * 100).toFixed(0)}%`
                    : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2.5 font-medium">{children}</th>;
}

function ThButton({
  children,
  active,
  dir,
  onClick,
  align,
}: {
  children: React.ReactNode;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align: "right" | "left";
}) {
  return (
    <th
      className={`px-4 py-2.5 font-medium ${align === "right" ? "text-right" : "text-left"}`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 hover:text-ink transition-colors ${
          active ? "text-ink" : ""
        }`}
      >
        {children}
        <span aria-hidden className="text-[9px] opacity-70">
          {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

const CATEGORY_COLORS: Record<PmTopMarket["category"], string> = {
  Politics: "#14b8a6",
  Sports: "#06b6d4",
  Crypto: "#6366f1",
  Macro: "#8b5cf6",
  Other: "#64748b",
};

function CategoryPill({ category }: { category: PmTopMarket["category"] }) {
  const color = CATEGORY_COLORS[category];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
      style={{ background: `${color}1f`, color }}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ background: color }}
        aria-hidden
      />
      {category}
    </span>
  );
}

function readSortField(m: PmTopMarket, key: SortKey): number | null {
  switch (key) {
    case "volume":
      return m.volume24h;
    case "oi":
      return m.openInterest;
    case "probability":
      return m.probability;
    case "endDate":
      return m.endDate ? new Date(m.endDate).getTime() : null;
  }
}

function fmtEndDate(d: string | null): string {
  if (!d) return "-";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toISOString().slice(0, 10);
}

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
