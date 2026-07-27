"use client";

import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import type { BridgeProviderRow } from "@/lib/bridge-hub-stats";

const TYPE_LABELS: Record<string, string> = {
  intent: "Intent layer",
  relay: "Relay",
  aggregator: "Aggregator",
  protocol: "Protocol",
};

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(2)}%`;
}

function fmtMs(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

function fmtSuccess(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  // successRate stored as 0-100 in ProviderResult blob
  return `${v.toFixed(1)}%`;
}

export function BridgeHubTable({
  rows,
}: {
  rows: BridgeProviderRow[];
}) {
  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-xl border border-ink/10">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink/10 bg-ink/[0.02]">
            <th className="text-left px-4 py-3 text-[11px] label-mono text-ink-faint font-normal w-8">
              #
            </th>
            <th className="text-left px-4 py-3 text-[11px] label-mono text-ink-faint font-normal">
              Provider
            </th>
            <th className="text-left px-4 py-3 text-[11px] label-mono text-ink-faint font-normal hidden sm:table-cell">
              Type
            </th>
            {/* Fee group */}
            <th className="text-right px-4 py-3 text-[11px] label-mono text-ink-faint font-normal">
              Fee p50
            </th>
            <th className="text-right px-4 py-3 text-[11px] label-mono text-ink-faint font-normal hidden lg:table-cell">
              Fee p99
            </th>
            {/* Latency group */}
            <th className="text-right px-4 py-3 text-[11px] label-mono text-ink-faint font-normal hidden md:table-cell">
              Quote p50
            </th>
            <th className="text-right px-4 py-3 text-[11px] label-mono text-ink-faint font-normal hidden xl:table-cell">
              Quote p99
            </th>
            {/* Success */}
            <th className="text-right px-4 py-3 text-[11px] label-mono text-ink-faint font-normal hidden md:table-cell">
              Success
            </th>
          </tr>
          {/* Sub-header labels */}
          <tr className="border-b border-ink/5 bg-ink/[0.01]">
            <td colSpan={3} />
            <td
              colSpan={2}
              className="px-4 py-1 text-[10px] text-indigo-500 label-mono text-right hidden lg:table-cell"
            >
              all-in fee · $300 USDC
            </td>
            <td className="px-4 py-1 text-[10px] text-indigo-500 label-mono text-right hidden lg:table-cell lg:hidden" />
            <td
              colSpan={2}
              className="px-4 py-1 text-[10px] text-ink-faint label-mono text-right hidden xl:table-cell"
            >
              quote latency
            </td>
            <td className="hidden md:table-cell xl:hidden px-4 py-1 text-[10px] text-ink-faint label-mono text-right">
              quote latency
            </td>
            <td className="hidden md:table-cell" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isLeader = i === 0;
            return (
              <tr
                key={row.slug}
                className={`border-b border-ink/5 last:border-0 hover:bg-ink/[0.025] transition-colors ${isLeader ? "bg-indigo-500/[0.03]" : ""}`}
              >
                <td className="px-4 py-3.5 text-ink-faint tabular-nums text-[12px] font-mono">
                  {isLeader ? (
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-500/15 text-indigo-600 text-[10px] font-semibold">
                      1
                    </span>
                  ) : (
                    i + 1
                  )}
                </td>
                <td className="px-4 py-3.5">
                  <Link
                    href={`/products/${row.slug}`}
                    className="inline-flex items-center gap-2.5 group"
                  >
                    <ProviderLogo slug={row.slug} name={row.name} size={24} />
                    <span className="font-medium text-ink group-hover:underline leading-tight">
                      {row.name}
                    </span>
                  </Link>
                </td>
                <td className="px-4 py-3.5 hidden sm:table-cell">
                  {row.type && (
                    <span className="inline-flex rounded-full bg-ink/5 px-2 py-0.5 text-[11px] text-ink-soft">
                      {TYPE_LABELS[row.type] ?? row.type}
                    </span>
                  )}
                </td>
                {/* Fee p50 — primary ranking metric */}
                <td className="px-4 py-3.5 text-right tabular-nums font-semibold text-ink">
                  {fmtPct(row.feep50)}
                </td>
                {/* Fee p99 */}
                <td className="px-4 py-3.5 text-right tabular-nums text-ink-soft hidden lg:table-cell">
                  {fmtPct(row.feep99)}
                </td>
                {/* Quote p50 */}
                <td className="px-4 py-3.5 text-right tabular-nums text-ink-soft hidden md:table-cell">
                  {fmtMs(row.quotep50)}
                </td>
                {/* Quote p99 */}
                <td className="px-4 py-3.5 text-right tabular-nums text-ink-soft hidden xl:table-cell">
                  {fmtMs(row.quotep99)}
                </td>
                {/* Success */}
                <td className="px-4 py-3.5 text-right tabular-nums hidden md:table-cell">
                  <span
                    className={
                      row.feeSuccess != null && row.feeSuccess < 80
                        ? "text-amber-600"
                        : "text-ink-soft"
                    }
                  >
                    {fmtSuccess(row.feeSuccess)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
