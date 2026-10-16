"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import type { RpcHubPivotRow } from "@/lib/rpc-hub-shape";

/**
 * Provider pivot for /rpc: one row per free RPC gateway across every
 * measured chain. Coverage (chains served / chains benched), median
 * leaderboard rank, median 24h p50 across covered chains, plus a
 * per-chain cell strip: rank number in a small square, colored by
 * standing (#1 = solid, top-3 = tinted, rest = neutral, uncovered =
 * empty). Hover any cell for chain, p50 and rank.
 *
 * This is the view no single bench page can give: "which endpoint do
 * I standardize on across my whole multichain deployment".
 */

type ChainRef = { chain: string; name: string; slug: string };

type SortKey =
  | "chainsCovered"
  | "medianRank"
  | "medianP50Ms"
  | "medianSuccessPct"
  | "errors24h";

/** Optional reliability fields (absent on old snapshots) resolve to
 *  null so the comparator can pin them to the bottom either way. */
function sortValue(r: RpcHubPivotRow, k: SortKey): number | null {
  const v = r[k];
  return v ?? null;
}

export function RpcProvidersPivot({
  rows,
  chains,
  regionLabel = "all regions",
  geoControl,
  raceMode = false,
}: {
  rows: RpcHubPivotRow[];
  chains: ChainRef[];
  /** Which probe scope the cells were measured in, named in the footnote.
   *  The hub's geo selector re-scopes the rows to one region, and a cell
   *  that reads "all regions" when it holds Singapore only is a wrong
   *  caption on a right number. */
  regionLabel?: string;
  /** The hub's region selector, rendered in this table's header bar so the
   *  control sits with the caption it changes. */
  geoControl?: React.ReactNode;
  /** The block-push cohort is a race: this column is a median lag behind
   *  whichever provider pushed the block first, not a latency, and the
   *  winner sits near zero because it is zero behind itself. */
  raceMode?: boolean;
}) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("chainsCovered");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = needle
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(needle) ||
            r.provider.toLowerCase().includes(needle),
        )
      : rows;
    const factor = sortDir === "desc" ? -1 : 1;
    return [...out].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      // Rows without the metric (old snapshot, no sampleSize) sink to
      // the bottom regardless of direction.
      if (av == null && bv == null) {
        return (
          b.chainsCovered - a.chainsCovered || a.medianRank - b.medianRank
        );
      }
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) {
        // Stable tie-breaks: coverage, then rank quality.
        return (
          b.chainsCovered - a.chainsCovered || a.medianRank - b.medianRank
        );
      }
      return factor * (av - bv);
    });
  }, [rows, sortKey, sortDir, q]);

  /** Both are optional on the row and absent whenever the cohort's specs
   *  have no success or sample-size query that resolves. A column of dashes
   *  states "no failures counted", which is a claim about the providers
   *  rather than about the measurement. */
  const hasSuccess = useMemo(
    () => rows.some((r) => r.medianSuccessPct != null),
    [rows],
  );
  const hasErrors = useMemo(
    () => rows.some((r) => r.errors24h != null),
    [rows],
  );

  const setSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      // Coverage + success read best descending; rank, latency and
      // error counts ascending.
      setSortDir(
        k === "chainsCovered" || k === "medianSuccessPct" ? "desc" : "asc",
      );
    }
  };

  return (
    <div className="mt-6 card-soft rounded-xl border border-ink/10">
      <div className="p-3 sm:p-4 border-b border-ink/8 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          <p
            className="text-[11px] text-ink-faint"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {filtered.length} of {rows.length} providers · rank + median
            p50 across {chains.length} chains, {regionLabel}
          </p>
          {geoControl}
        </div>
        <input
          type="search" aria-label="Search provider..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search provider..."
          className="text-[12.5px] px-3 py-1.5 rounded-md border border-ink/15 bg-paper focus:outline-none focus:ring-2 focus:ring-sky-500/30 min-w-[180px]"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <Th>Provider</Th>
              <ThSort
                active={sortKey === "chainsCovered"}
                dir={sortDir}
                onClick={() => setSort("chainsCovered")}
              >
                Chains covered
              </ThSort>
              <ThSort
                active={sortKey === "medianRank"}
                dir={sortDir}
                onClick={() => setSort("medianRank")}
              >
                Median rank
              </ThSort>
              <ThSort
                active={sortKey === "medianP50Ms"}
                dir={sortDir}
                onClick={() => setSort("medianP50Ms")}
              >
                <span
                  title={
                    raceMode
                      ? "Median milliseconds behind whichever provider pushed the block first, across covered chains. The leader sits near zero because it is zero behind itself; read the trailers' distance from it."
                      : "Median 24h p50 across the chains this provider covers."
                  }
                >
                  {raceMode ? "Median lag" : "Median p50"}
                </span>
              </ThSort>
              {hasSuccess && (
                <ThSort
                  active={sortKey === "medianSuccessPct"}
                  dir={sortDir}
                  onClick={() => setSort("medianSuccessPct")}
                >
                  Success
                </ThSort>
              )}
              {hasErrors && (
                <ThSort
                  active={sortKey === "errors24h"}
                  dir={sortDir}
                  onClick={() => setSort("errors24h")}
                >
                  Errors (24h)
                </ThSort>
              )}
              {/* Chain logos double as column headers for the rank
                  strip below: same 22px slots + gap as the cells, so
                  each rank square reads under its chain mark. */}
              <Th>
                <span className="sr-only">Per-chain rank</span>
                <span className="inline-flex items-center gap-1" aria-hidden>
                  {chains.map((c) => (
                    <span
                      key={c.chain}
                      title={c.name}
                      className="inline-flex items-center justify-center w-[22px]"
                    >
                      <ProviderLogo slug={c.chain} name={c.name} size={15} />
                    </span>
                  ))}
                </span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr
                key={r.provider}
                onClick={() => router.push(`/products/${r.provider}`)}
                className="border-t border-ink/5 hover:bg-paper-soft/40 transition-colors cursor-pointer"
              >
                <Td muted mono>
                  {i + 1}
                </Td>
                <Td>
                  <Link
                    href={`/products/${r.provider}`}
                    className="flex items-center gap-2 min-w-0 group"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ProviderLogo
                      slug={r.provider}
                      name={r.name}
                      size={18}
                    />
                    <span className="font-medium text-ink truncate group-hover:underline underline-offset-2">
                      {r.name}
                    </span>
                    <ChevronRight
                      size={14}
                      className="text-ink-faint shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    />
                  </Link>
                </Td>
                <Td mono>
                  <span className="inline-flex items-center gap-2">
                    <span className="tabular-nums">
                      {r.chainsCovered}/{chains.length}
                    </span>
                    <span
                      className="inline-block h-1.5 w-16 rounded-full bg-ink/10 overflow-hidden"
                      aria-hidden
                    >
                      <span
                        className="block h-full rounded-full bg-sky-500/70"
                        style={{
                          width: `${Math.round(
                            (r.chainsCovered / Math.max(chains.length, 1)) *
                              100,
                          )}%`,
                        }}
                      />
                    </span>
                  </span>
                </Td>
                <Td mono>#{fmtRank(r.medianRank)}</Td>
                <Td mono>{fmtMs(r.medianP50Ms)}</Td>
                {hasSuccess && (
                  <Td mono>
                    {r.medianSuccessPct != null
                      ? `${r.medianSuccessPct.toFixed(2)}%`
                      : "—"}
                  </Td>
                )}
                {hasErrors && (
                  <Td mono muted>
                    {r.errors24h != null
                      ? r.errors24h.toLocaleString("en-US")
                      : "—"}
                  </Td>
                )}
                <Td>
                  <span className="inline-flex items-center gap-1">
                    {chains.map((c) => {
                      const cell = r.chains[c.chain];
                      return (
                        <span
                          key={c.chain}
                          title={
                            cell
                              ? `${c.name}: ${fmtMs(cell.p50Ms)} · rank #${cell.rank}`
                              : `${c.name}: not covered`
                          }
                          className={`inline-flex items-center justify-center w-[22px] h-[18px] rounded text-[9.5px] tabular-nums ${cellClass(
                            cell?.rank,
                          )}`}
                          style={{
                            fontFamily: "var(--font-mono, monospace)",
                          }}
                        >
                          {cell ? cell.rank : "·"}
                        </span>
                      );
                    })}
                  </span>
                </Td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={6 + (hasSuccess ? 1 : 0) + (hasErrors ? 1 : 0)}
                  className="px-3 py-8 text-center text-[12px] text-ink-faint"
                >
                  No provider matches &ldquo;{q}&rdquo;.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="px-3 sm:px-4 py-2.5 border-t border-ink/8 text-[10.5px] text-ink-faint">
        Per-chain cells show the provider&apos;s leaderboard rank on the
        chain marked by the logo above (24h p50, {regionLabel}).
        {hasSuccess
          ? " Success is the median 24h success rate across covered chains."
          : ""}
        {hasErrors
          ? " Errors (24h) is the summed failed-probe count (sample size × failure rate)."
          : ""}
      </p>
    </div>
  );
}

function cellClass(rank?: number): string {
  if (rank == null) return "bg-transparent text-ink-faint/50 border border-ink/8";
  if (rank === 1)
    return "bg-sky-500/85 text-white font-semibold";
  if (rank <= 3)
    return "bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/25";
  return "bg-paper-soft text-ink-soft border border-ink/10";
}

function fmtRank(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
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

function fmtMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "...";
  // One decimal below 10 ms. Rounding to the nearest millisecond printed a
  // 0.3 ms median as "0 ms", which reads as a broken measurement rather than
  // as a provider that is a third of a millisecond behind, and it flattened
  // 2.1 against 5.8 into 2 against 6 on the HTTP cohorts.
  if (v < 10) return `${v.toFixed(1)} ms`;
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}
