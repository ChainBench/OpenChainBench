"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import type { PerpAssetRow } from "@/lib/perp-stats";

/**
 * Per-asset funding matrix for the /perps "By asset" tab. One row per
 * venue, three funding columns (BTC, ETH, SOL) plus the perp-fees
 * all-in ETH column. Style mirrors PerpVenuesLeaderboard so the two
 * tabs feel like one widget: same Th/ThSort/Td primitives, same row
 * click target, same search affordance.
 *
 * Default sort: funding ETH ascending = lowest cost to hold a long
 * surfaces first, which is what a trader scanning the tab wants.
 */

type SortKey = "fundingBtc" | "fundingEth" | "fundingSol" | "feeEthBps";

export function PerpByAssetTable({ rows }: { rows: PerpAssetRow[] }) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("fundingEth");
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
      const av = a[sortKey];
      const bv = b[sortKey];
      // Nulls sink under either direction so empty cells never claim
      // rank #1; matches PerpVenuesLeaderboard sort semantics.
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
      // ETH funding defaults to ascending (best for longs); the other
      // numeric columns default to descending so the highest cost or
      // highest fee floats to the top when the user clicks the header.
      setSortDir(k === "fundingEth" ? "asc" : "desc");
    }
  };

  if (rows.length === 0) {
    return (
      <div className="mt-6 card-soft rounded-xl border border-ink/10 p-8 text-center">
        <p
          className="text-[11px] text-ink-faint uppercase tracking-wide mb-2"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          Data warming up
        </p>
        <p className="text-[12.5px] text-ink-faint italic">
          The per-asset funding matrix needs a fresh harness scrape
          across BTC, ETH and SOL. Check back in a minute, or browse the
          DEX venues tab for the cohort view.
        </p>
      </div>
    );
  }

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
          type="search" aria-label="Search venue..."
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
                active={sortKey === "fundingBtc"}
                dir={sortDir}
                onClick={() => setSort("fundingBtc")}
              >
                Funding BTC 24h
              </ThSort>
              <ThSort
                active={sortKey === "fundingEth"}
                dir={sortDir}
                onClick={() => setSort("fundingEth")}
              >
                Funding ETH 24h
              </ThSort>
              <ThSort
                active={sortKey === "fundingSol"}
                dir={sortDir}
                onClick={() => setSort("fundingSol")}
              >
                Funding SOL 24h
              </ThSort>
              <ThSort
                active={sortKey === "feeEthBps"}
                dir={sortDir}
                onClick={() => setSort("feeEthBps")}
              >
                All-in fee ETH
              </ThSort>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const productHref =
                r.slug === "gmx-v2" ? "/products/gmx" : `/products/${r.slug}`;
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
                      <ChevronRight
                        size={14}
                        className="text-ink-faint shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </Link>
                  </Td>
                  <Td mono>{fmtBpsSigned(r.fundingBtc)}</Td>
                  <Td mono>{fmtBpsSigned(r.fundingEth)}</Td>
                  <Td mono>{fmtBpsSigned(r.fundingSol)}</Td>
                  <Td mono>{fmtBps(r.feeEthBps)}</Td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={6}
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

function fmtBps(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  if (Math.abs(v) >= 100) return `${v.toFixed(0)} bps`;
  return `${v.toFixed(1)} bps`;
}

function fmtBpsSigned(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const sign = v > 0 ? "+" : "";
  if (Math.abs(v) >= 100) return `${sign}${v.toFixed(0)} bps`;
  return `${sign}${v.toFixed(1)} bps`;
}
