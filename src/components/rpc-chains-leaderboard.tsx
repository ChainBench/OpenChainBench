"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import { Sparkline } from "@/components/sparkline";
import type { RpcHubChain, RpcRegionKey } from "@/lib/rpc-hub-stats";

/**
 * Sortable + searchable chain matrix for /rpc. One row per `-rpc`
 * bench: fastest provider overall (highlighted), fastest per probe
 * region (US-East / EU-West / Singapore), live provider count and the
 * leader's 24h latency sparkline. Rows link to the per-chain bench
 * page where the full leaderboard + region tabs live.
 *
 * Data is pure SSR input; this component only owns sort + search state.
 */

type SortKey =
  | "name"
  | "bestP50"
  | "us-east"
  | "eu-west"
  | "sgp"
  | "providerCount";

const REGION_COLS: { key: RpcRegionKey; label: string }[] = [
  { key: "us-east", label: "US-East" },
  { key: "eu-west", label: "EU-West" },
  { key: "sgp", label: "Singapore" },
];

function sortValue(r: RpcHubChain, k: SortKey): number | string | null {
  if (k === "name") return r.name.toLowerCase();
  if (k === "bestP50") return r.best?.p50Ms ?? null;
  if (k === "providerCount") return r.providerCount;
  return r.regions[k]?.p50Ms ?? null;
}

export function RpcChainsLeaderboard({ rows }: { rows: RpcHubChain[] }) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("bestP50");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = needle
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(needle) ||
            r.chain.toLowerCase().includes(needle) ||
            (r.best?.providerName.toLowerCase().includes(needle) ?? false),
        )
      : rows;
    const factor = sortDir === "desc" ? -1 : 1;
    return [...out].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      // Nulls always sink under either sort direction.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string")
        return factor * av.localeCompare(bv);
      return factor * ((av as number) - (bv as number));
    });
  }, [rows, sortKey, sortDir, q]);

  const setSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      // Latency columns read best ascending; counts descending.
      setSortDir(k === "providerCount" ? "desc" : "asc");
    }
  };

  return (
    <div className="mt-6 card-soft rounded-xl border border-ink/10">
      <div className="p-3 sm:p-4 border-b border-ink/8 flex items-center justify-between gap-3 flex-wrap">
        <p
          className="text-[11px] text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {filtered.length} of {rows.length} chains · 24h p50, 3 probe
          regions
        </p>
        <input
          type="search" aria-label="Search chain or provider..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search chain or provider..."
          className="text-[12.5px] px-3 py-1.5 rounded-md border border-ink/15 bg-paper focus:outline-none focus:ring-2 focus:ring-sky-500/30 min-w-[200px]"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <ThSort
                active={sortKey === "name"}
                dir={sortDir}
                onClick={() => setSort("name")}
              >
                Chain
              </ThSort>
              <ThSort
                active={sortKey === "bestP50"}
                dir={sortDir}
                onClick={() => setSort("bestP50")}
              >
                <span title="Lowest p50 averaged across the 3 probe regions. A provider can win overall without winning any single region: consistent everywhere beats fast in one region, slow elsewhere.">
                  Best overall (3-region avg)
                </span>
              </ThSort>
              {REGION_COLS.map((c) => (
                <ThSort
                  key={c.key}
                  active={sortKey === c.key}
                  dir={sortDir}
                  onClick={() => setSort(c.key)}
                >
                  {c.label}
                </ThSort>
              ))}
              <ThSort
                active={sortKey === "providerCount"}
                dir={sortDir}
                onClick={() => setSort("providerCount")}
              >
                Providers
              </ThSort>
              <Th>24h trend</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr
                key={r.slug}
                onClick={() => router.push(`/benchmarks/${r.slug}`)}
                className="border-t border-ink/5 hover:bg-paper-soft/40 transition-colors cursor-pointer"
              >
                <Td muted mono>
                  {i + 1}
                </Td>
                <Td>
                  <Link
                    href={`/benchmarks/${r.slug}`}
                    className="flex items-center gap-2 min-w-0 group"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ProviderLogo slug={r.chain} name={r.name} size={18} />
                    <span className="font-medium text-ink truncate group-hover:underline underline-offset-2">
                      {r.name}
                    </span>
                    <ChevronRight
                      size={14}
                      className="text-ink-faint shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    />
                  </Link>
                </Td>
                <Td>
                  {r.best ? (
                    <span className="inline-flex items-center gap-2 min-w-0">
                      <ProviderLogo
                        slug={r.best.provider}
                        name={r.best.providerName}
                        size={16}
                      />
                      <span className="truncate text-ink">
                        {r.best.providerName}
                      </span>
                      <span
                        className="tabular-nums font-semibold text-sky-600 dark:text-sky-400"
                        style={{ fontFamily: "var(--font-mono, monospace)" }}
                      >
                        {fmtMs(r.best.p50Ms)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-ink-faint">...</span>
                  )}
                </Td>
                {REGION_COLS.map((c) => {
                  const b = r.regions[c.key];
                  return (
                    <Td
                      key={c.key}
                      mono
                      tip={
                        b
                          ? `${b.providerName} leads ${r.name} from ${c.label}`
                          : undefined
                      }
                    >
                      {b ? (
                        <span className="inline-flex items-baseline gap-1.5">
                          <span className="tabular-nums">{fmtMs(b.p50Ms)}</span>
                          <span className="text-[10.5px] text-ink-faint truncate max-w-[72px]">
                            {b.providerName}
                          </span>
                        </span>
                      ) : (
                        "..."
                      )}
                    </Td>
                  );
                })}
                <Td
                  mono
                  tip={
                    r.unresponsiveCount
                      ? `${r.unresponsiveCount} cohort provider${r.unresponsiveCount > 1 ? "s" : ""} currently unresponsive on ${r.name} (probed, all calls failing). Not counted in best/fastest.`
                      : undefined
                  }
                >
                  {r.providerCount}
                  {r.unresponsiveCount ? (
                    <span className="ml-1.5 text-[10px] text-ink-faint">
                      +{r.unresponsiveCount} down
                    </span>
                  ) : null}
                </Td>
                <Td>
                  {r.series && r.series.length > 1 ? (
                    <Sparkline
                      values={r.series}
                      width={84}
                      height={20}
                      color="var(--color-ink-soft)"
                    />
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </Td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-8 text-center text-[12px] text-ink-faint"
                >
                  No chain matches &ldquo;{q}&rdquo;.
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
  tip,
}: {
  children: React.ReactNode;
  mono?: boolean;
  muted?: boolean;
  tip?: string;
}) {
  return (
    <td
      className={`px-3 py-2 tabular-nums ${muted ? "text-ink-faint" : ""}`}
      style={mono ? { fontFamily: "var(--font-mono, monospace)" } : undefined}
      title={tip}
    >
      {children}
    </td>
  );
}

function fmtMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}
