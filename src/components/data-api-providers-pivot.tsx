"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import {
  GROUP_ORDER,
  GROUP_META,
  fmtDataValue,
  type DataApiProviderPivotRow,
  type DataApiRegionScore,
  type DataApiGroup,
} from "@/lib/data-api-stats";

type SortKey = "groupCount" | DataApiGroup;

export function DataApiProvidersPivot({
  rows,
  groupCount,
}: {
  rows: DataApiProviderPivotRow[];
  groupCount: number;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("groupCount");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = needle
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(needle) ||
            r.slug.toLowerCase().includes(needle),
        )
      : rows;

    return [...base].sort((a, b) => {
      const factor = sortDir === "desc" ? -1 : 1;

      if (sortKey === "groupCount") {
        if (b.groupCount !== a.groupCount)
          return factor * (b.groupCount - a.groupCount);
        // tie-break: better avg rank
        const avgA = a.cells.reduce((s, c) => s + c.rank, 0) / (a.cells.length || 1);
        const avgB = b.cells.reduce((s, c) => s + c.rank, 0) / (b.cells.length || 1);
        return avgA - avgB;
      }

      // Sort by a specific group's best rank
      const cellA = a.groups[sortKey];
      const cellB = b.groups[sortKey];
      if (!cellA && !cellB) return 0;
      if (!cellA) return 1;
      if (!cellB) return -1;
      // rank: lower = better always
      return factor * (cellA.bestRank - cellB.bestRank);
    });
  }, [rows, sortKey, sortDir, q]);

  const setSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  const visibleGroups = GROUP_ORDER.filter(
    (g) => rows.some((r) => r.groups[g]),
  );

  return (
    <div className="rounded-xl border border-ink/10 card-soft overflow-hidden">
      <div className="px-4 py-3 border-b border-ink/8 flex items-center justify-between gap-3 flex-wrap">
        <p
          className="text-[11px] text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {filtered.length} of {rows.length} providers across {groupCount} benchmark groups
        </p>
        <input
          type="search"
          aria-label="Search provider..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search provider..."
          className="text-[12.5px] px-3 py-1.5 rounded-md border border-ink/15 bg-paper focus:outline-none focus:ring-2 focus:ring-violet-500/30 min-w-[180px]"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th className="pl-4 pr-3 py-2.5 w-6">#</Th>
              <Th className="px-3 py-2.5 min-w-[150px]">Provider</Th>
              <ThSort
                active={sortKey === "groupCount"}
                dir={sortDir}
                onClick={() => setSort("groupCount")}
              >
                Coverage
              </ThSort>
              {visibleGroups.map((g) => (
                <ThSort
                  key={g}
                  active={sortKey === g}
                  dir={sortDir}
                  onClick={() => setSort(g)}
                  accent={GROUP_META[g].accent}
                >
                  {GROUP_META[g].shortLabel}
                </ThSort>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink/5">
            {filtered.map((row, idx) => (
              <ProviderRow
                key={row.slug}
                row={row}
                rank={idx + 1}
                groups={visibleGroups}
              />
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="px-4 py-8 text-center text-[13px] text-ink-faint">
          No providers match &quot;{q}&quot;
        </div>
      )}
    </div>
  );
}

function ProviderRow({
  row,
  rank,
  groups,
}: {
  row: DataApiProviderPivotRow;
  rank: number;
  groups: DataApiGroup[];
}) {
  return (
    <tr className="group hover:bg-paper-soft/30 transition-colors">
      <td className="pl-4 pr-3 py-3 align-middle">
        <span
          className="label-mono text-[10.5px] text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {rank}
        </span>
      </td>
      <td className="px-3 py-3 align-middle">
        <Link
          href={`/products/${row.slug}`}
          className="flex items-center gap-2 hover:text-violet-600 transition-colors"
        >
          <ProviderLogo slug={row.slug} name={row.name} size={20} />
          <span className="font-medium text-ink leading-tight">{row.name}</span>
        </Link>
      </td>

      {/* Coverage column */}
      <td className="px-3 py-3 align-middle">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-ink">{row.groupCount}</span>
          <span className="text-ink-faint text-[11px]">/ {groups.length}</span>
          <div className="flex gap-0.5 ml-1">
            {groups.map((g) => (
              <span
                key={g}
                className="inline-block w-2 h-2 rounded-full"
                style={{
                  background: row.groups[g]
                    ? GROUP_META[g].accent
                    : "var(--color-ink-faint, #94a3b8)",
                  opacity: row.groups[g] ? 1 : 0.2,
                }}
                title={
                  row.groups[g]
                    ? `${GROUP_META[g].label}: rank #${row.groups[g]!.bestRank}`
                    : `Not in ${GROUP_META[g].label}`
                }
              />
            ))}
          </div>
        </div>
      </td>

      {/* One cell per group */}
      {groups.map((g) => (
        <td key={g} className="px-3 py-3 align-middle">
          <GroupCell cell={row.groups[g]} group={g} />
        </td>
      ))}
    </tr>
  );
}

function GroupCell({
  cell,
  group,
}: {
  cell: DataApiProviderPivotRow["groups"][DataApiGroup];
  group: DataApiGroup;
}) {
  if (!cell) {
    return <span className="text-ink-faint/40 text-[11px]">—</span>;
  }

  const { bestRank, bestCell } = cell;
  const accent = GROUP_META[group].accent;
  const hasRegions = bestCell.regions && bestCell.regions.length > 0;

  const bg =
    bestRank === 1
      ? `${accent}22`
      : bestRank <= 3
        ? `${accent}11`
        : "transparent";

  const textColor =
    bestRank === 1
      ? accent
      : bestRank <= 3
        ? accent
        : "var(--color-ink-soft)";

  return (
    <div
      className="inline-flex flex-col items-start gap-1 rounded-md px-2 py-1.5 min-w-[110px]"
      style={{ background: bg }}
    >
      {/* Global rank + value */}
      <div className="flex items-center gap-1.5">
        <RankBadge rank={bestRank} accent={accent} />
        <span
          className="label-mono text-[11px] font-semibold"
          style={{ color: textColor, fontFamily: "var(--font-mono, monospace)" }}
        >
          {fmtDataValue(bestCell.p50, bestCell.unit)}
        </span>
      </div>
      <span className="text-[9px] text-ink-faint leading-tight">
        {bestCell.benchShortTitle.replace("coverage", "cov.").replace("freshness", "fresh.")}
      </span>
      {/* Regional sub-scores */}
      {hasRegions && (
        <RegionSubScores
          regions={bestCell.regions!}
          unit={bestCell.unit}
          accent={accent}
        />
      )}
    </div>
  );
}

function RegionSubScores({
  regions,
  unit,
  accent,
}: {
  regions: DataApiRegionScore[];
  unit: DataApiProviderPivotRow["cells"][number]["unit"];
  accent: string;
}) {
  return (
    <div className="flex items-center gap-1.5 pt-0.5 border-t border-ink/8 w-full">
      {regions.map((r) => (
        <div
          key={r.region}
          className="flex items-center gap-0.5"
          title={`${r.label}: #${r.rank} — ${fmtDataValue(r.p50, unit)}`}
        >
          <span
            className="text-[8px] font-medium uppercase text-ink-faint"
            style={{ letterSpacing: "0.04em" }}
          >
            {r.label}
          </span>
          <span
            className="text-[9px] font-bold"
            style={{ color: r.rank === 1 ? accent : "var(--color-ink-faint)" }}
          >
            #{r.rank}
          </span>
        </div>
      ))}
    </div>
  );
}

function RankBadge({ rank, accent }: { rank: number; accent: string }) {
  const bg = rank === 1 ? accent : "transparent";
  const border = rank <= 3 ? `1px solid ${accent}66` : "1px solid transparent";
  const color =
    rank === 1 ? "#fff" : rank <= 3 ? accent : "var(--color-ink-faint)";

  return (
    <span
      className="inline-flex items-center justify-center rounded w-4 h-4 text-[9px] font-bold flex-shrink-0"
      style={{ background: bg, border, color }}
    >
      {rank}
    </span>
  );
}

function Th({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`label-mono text-[10px] text-ink-faint font-medium py-2.5 px-3 ${className}`}
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
  accent,
}: {
  children: React.ReactNode;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  accent?: string;
}) {
  return (
    <th
      className="py-2.5 px-3 text-left"
      style={{ fontFamily: "var(--font-mono, monospace)" }}
    >
      <button
        type="button"
        onClick={onClick}
        className="label-mono text-[10px] font-medium flex items-center gap-1 hover:text-ink transition-colors"
        style={{ color: active ? (accent ?? "var(--color-ink)") : undefined }}
      >
        {children}
        <span className="text-[8px]">{active ? (dir === "desc" ? "▼" : "▲") : "⇅"}</span>
      </button>
    </th>
  );
}
