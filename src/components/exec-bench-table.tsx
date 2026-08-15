"use client";

import { useState } from "react";
import type { ExecLeaderboardResponse } from "@/lib/solana-exec";
import { PLATFORM_DISPLAY, lamportsToSOL, fmtCUPrice } from "@/lib/solana-exec";

const NOW_MS = Date.now();
const WINDOWS = ["24h", "7d", "30d"] as const;
type Window = (typeof WINDOWS)[number];

function fmtCount(n: number): string {
  if (n === 0) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function fmtPct(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}

function Dash() {
  return <span className="text-ink-faint">—</span>;
}

export function ExecBenchTable({
  data,
}: {
  data: ExecLeaderboardResponse | null;
}) {
  const [win, setWin] = useState<Window>("24h");
  const stale =
    data?.updatedAt
      ? NOW_MS - new Date(data.updatedAt).getTime() > 3 * 60 * 60 * 1000
      : false;

  if (!data) {
    return (
      <div className="card rounded-xl py-12 text-center text-ink-muted text-sm">
        Data unavailable — exec API may be warming up.
      </div>
    );
  }

  const sorted = [...(data.platforms ?? [])].sort(
    (a, b) =>
      (b.windows[win]?.txCount ?? 0) - (a.windows[win]?.txCount ?? 0),
  );

  return (
    <div className="card rounded-xl overflow-hidden">
      <div className="px-4 sm:px-6 pt-4 pb-0 flex items-end justify-between gap-4 flex-wrap border-b border-rule">
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWin(w)}
              className={`px-3 py-2 text-sm font-mono border-b-2 transition-colors ${
                win === w
                  ? "border-accent text-ink font-medium"
                  : "border-transparent text-ink-muted hover:text-ink-soft"
              }`}
            >
              {w}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 pb-2">
          {stale && (
            <span className="text-[11px] text-amber-500 font-mono">stale</span>
          )}
          {data.updatedAt && (
            <span className="text-[11px] text-ink-faint font-mono">
              Updated {new Date(data.updatedAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rule">
              <th className="text-left py-3 pl-4 sm:pl-6 pr-3 font-medium text-ink-muted text-xs w-8">
                #
              </th>
              <th className="text-left py-3 pr-4 font-medium text-ink-muted text-xs">
                Platform
              </th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs">
                Tx Count
              </th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden sm:table-cell">
                Jito Rate
              </th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden sm:table-cell">
                CU p50
              </th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden md:table-cell">
                CU p95
              </th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden md:table-cell">
                Prio Fee
              </th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden lg:table-cell">
                Platform Fee
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => {
              const wm = p.windows[win];
              const empty = !wm || wm.txCount === 0;

              return (
                <tr
                  key={p.platform}
                  className="border-b border-rule last:border-0 hover:bg-paper-soft transition-colors"
                >
                  <td className="py-4 pl-4 sm:pl-6 pr-3 text-ink-muted font-mono text-xs tabular-nums align-middle">
                    {i + 1}
                  </td>
                  <td className="py-4 pr-4 font-medium text-ink align-middle">
                    {PLATFORM_DISPLAY[p.platform] ?? p.platform}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono font-semibold text-ink tabular-nums align-middle">
                    {fmtCount(wm?.txCount ?? 0)}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-ink-soft tabular-nums align-middle hidden sm:table-cell">
                    {empty ? <Dash /> : fmtPct(wm.jitoRate)}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-xs text-ink-soft align-middle hidden sm:table-cell">
                    {empty ? <Dash /> : fmtCUPrice(wm.p50CUPriceMicro)}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-xs text-ink-soft align-middle hidden md:table-cell">
                    {empty ? <Dash /> : fmtCUPrice(wm.p95CUPriceMicro)}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-xs text-ink-soft tabular-nums align-middle hidden md:table-cell">
                    {empty ? (
                      <Dash />
                    ) : (
                      `${lamportsToSOL(wm.avgPriorityFeeLamports)} SOL`
                    )}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-xs text-ink-muted tabular-nums align-middle hidden lg:table-cell">
                    {empty ? (
                      <Dash />
                    ) : (
                      `${lamportsToSOL(wm.avgPlatformFeeLamports)} SOL`
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
