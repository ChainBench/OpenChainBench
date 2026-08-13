"use client";

import { useState } from "react";
import { logoPath } from "@/lib/logo-manifest";
import Image from "next/image";
import type { ExecPlatformRow, ExecWindowStats } from "@/lib/solana-exec";
import { PLATFORM_DISPLAY, fmtCUPrice, lamportsToSOL } from "@/lib/solana-exec";

const WINDOWS = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

const LOGO_KEY: Record<string, string> = {
  "pump.fun": "pump-portal",  // closest available logo
  "fomo": "fomo",
  "axiom": "axiom",
  "gmgn": "gmgn",
};

function Dash() {
  return <span className="text-ink-muted">—</span>;
}

function fmtCount(n: number): string {
  if (n === 0) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function fmtPct(r: number): string {
  if (r === 0) return "—";
  return `${(r * 100).toFixed(1)}%`;
}

export function SolanaExecTable({
  platforms,
  updatedAt,
}: {
  platforms: ExecPlatformRow[];
  updatedAt: string | null;
}) {
  const [win, setWin] = useState("24h");

  if (platforms.length === 0) {
    return (
      <div className="py-12 text-center text-ink-muted text-sm">
        No data yet — collector is warming up.
      </div>
    );
  }

  const sorted = [...platforms].sort(
    (a, b) => (b.windows[win]?.txCount ?? 0) - (a.windows[win]?.txCount ?? 0),
  );

  return (
    <div className="card rounded-xl overflow-hidden">
      <div className="px-4 sm:px-6 pt-4 pb-0 flex items-end justify-between gap-4 flex-wrap border-b border-rule">
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => setWin(w.key)}
              className={`px-3 py-2 text-sm font-mono border-b-2 transition-colors ${
                win === w.key
                  ? "border-accent text-ink font-medium"
                  : "border-transparent text-ink-muted hover:text-ink-soft"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        {updatedAt && (
          <span className="text-[11px] text-ink-faint font-mono pb-2">
            Updated {new Date(updatedAt).toLocaleString()}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rule">
              <th className="text-left py-3 pl-4 sm:pl-6 pr-3 font-medium text-ink-muted text-xs w-8">#</th>
              <th className="text-left py-3 pr-4 font-medium text-ink-muted text-xs">Platform</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs">Txs</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden sm:table-cell">Avg priority fee</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden sm:table-cell">CU price p50/p95</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden md:table-cell">Jito rate</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden md:table-cell">Avg platform fee</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => {
              const wm: ExecWindowStats | undefined = p.windows[win];
              const logo = logoPath(LOGO_KEY[p.platform] ?? p.platform);

              return (
                <tr
                  key={p.platform}
                  className="border-b border-rule last:border-0 hover:bg-paper-soft transition-colors"
                >
                  <td className="py-4 pl-4 sm:pl-6 pr-3 text-ink-muted font-mono text-xs tabular-nums align-middle">
                    {i + 1}
                  </td>
                  <td className="py-4 pr-4 align-middle">
                    <div className="flex items-center gap-2.5">
                      {logo && (
                        <Image
                          src={logo}
                          alt={PLATFORM_DISPLAY[p.platform] ?? p.platform}
                          width={24}
                          height={24}
                          className="rounded-full shrink-0 object-contain bg-paper-soft"
                        />
                      )}
                      <div className="font-medium text-ink leading-tight">
                        {PLATFORM_DISPLAY[p.platform] ?? p.platform}
                      </div>
                    </div>
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono font-semibold text-ink tabular-nums align-middle">
                    {wm?.txCount ? fmtCount(wm.txCount) : <Dash />}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-ink-soft tabular-nums align-middle hidden sm:table-cell">
                    {wm?.avgPriorityFeeLamports
                      ? `${Math.round(wm.avgPriorityFeeLamports).toLocaleString()} L`
                      : <Dash />}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-xs text-ink-soft align-middle hidden sm:table-cell">
                    {wm?.p50CUPriceMicro
                      ? `${fmtCUPrice(wm.p50CUPriceMicro)} / ${fmtCUPrice(wm.p95CUPriceMicro)}`
                      : <Dash />}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-ink-soft tabular-nums align-middle hidden md:table-cell">
                    {wm?.jitoRate != null && wm.jitoRate > 0 ? fmtPct(wm.jitoRate) : <Dash />}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-xs text-ink-muted align-middle hidden md:table-cell">
                    {wm?.avgPlatformFeeLamports
                      ? `${lamportsToSOL(wm.avgPlatformFeeLamports)} SOL`
                      : <Dash />}
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
