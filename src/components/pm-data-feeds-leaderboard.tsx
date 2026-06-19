"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ProviderLogo } from "@/components/provider-logo";
import type { PmDataFeedRow } from "@/lib/pm-stats";

/**
 * Data feeds leaderboard for /prediction-markets. Ranks every relay
 * tracked by the pm-data-freshness bench by p50 freshness lag against
 * the T0 reference (the venue itself). The reference row is rendered
 * with a "T0 reference" badge so it never claims a 0 ms freshness
 * lead over itself.
 */

type SortKey = "freshnessP50Ms" | "freshnessP99Ms" | "uptime24h";

export function PmDataFeedsLeaderboard({ rows }: { rows: PmDataFeedRow[] }) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("freshnessP50Ms");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("asc");
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
      // T0 reference always pins to the top of the list regardless of
      // sort: it sets the baseline that every other row measures against.
      if (a.isReference && !b.isReference) return -1;
      if (!a.isReference && b.isReference) return 1;
      const av = a[sortKey];
      const bv = b[sortKey];
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
      // Freshness fields are "lower is better", uptime is "higher is
      // better". Default direction follows the metric semantics so the
      // first click on a column shows the most useful ranking.
      setSortDir(k === "uptime24h" ? "desc" : "asc");
    }
  };

  return (
    <div className="mt-6 card-soft rounded-xl border border-ink/10">
      <div className="p-3 sm:p-4 border-b border-ink/8 flex items-center justify-between gap-3 flex-wrap">
        <p
          className="text-[11px] text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {filtered.length} of {rows.length} feeds
        </p>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search feed..."
          className="text-[12.5px] px-3 py-1.5 rounded-md border border-ink/15 bg-paper focus:outline-none focus:ring-2 focus:ring-teal-500/30 min-w-[180px]"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <Th>Provider</Th>
              <ThSort
                active={sortKey === "freshnessP50Ms"}
                dir={sortDir}
                onClick={() => setSort("freshnessP50Ms")}
              >
                p50 vs Polymarket T0
              </ThSort>
              <ThSort
                active={sortKey === "freshnessP99Ms"}
                dir={sortDir}
                onClick={() => setSort("freshnessP99Ms")}
              >
                p99 freshness
              </ThSort>
              <ThSort
                active={sortKey === "uptime24h"}
                dir={sortDir}
                onClick={() => setSort("uptime24h")}
              >
                24h uptime
              </ThSort>
              <Th>Coverage</Th>
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
                  <div className="flex items-center gap-2 min-w-0">
                    <ProviderLogo slug={r.slug} name={r.name} size={18} />
                    <span className="font-medium text-ink truncate">
                      {r.name}
                    </span>
                  </div>
                </Td>
                <Td mono>
                  {r.isReference ? (
                    <span
                      className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-700 border border-teal-500/30"
                      style={{ fontFamily: "var(--font-mono, monospace)" }}
                    >
                      T0 reference
                    </span>
                  ) : (
                    fmtMs(r.freshnessP50Ms)
                  )}
                </Td>
                <Td mono>{r.isReference ? "..." : fmtMs(r.freshnessP99Ms)}</Td>
                <Td mono>{fmtPct(r.uptime24h)}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {r.coverage.map((c) => (
                      <span
                        key={c}
                        className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-paper-soft border border-ink/15 text-ink-soft"
                        style={{ fontFamily: "var(--font-mono, monospace)" }}
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </Td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-8 text-center text-[12px] text-ink-faint"
                >
                  No feed matches &ldquo;{q}&rdquo;.
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

function fmtMs(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v < 1) return `${(v * 1000).toFixed(0)}us`;
  if (v < 1000) return `${v.toFixed(0)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  const pct = v * 100;
  if (pct >= 99.99) return "100%";
  if (pct >= 99) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(1)}%`;
}
