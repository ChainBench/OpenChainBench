"use client";

import { useState } from "react";
import type { ExecLeaderboardResponse } from "@/lib/solana-exec";
import type { EVMRevenueResponse, EVMPlatformRow } from "@/lib/evm-exec";
import { fmtUSD } from "@/lib/evm-exec";
import { PLATFORM_DISPLAY } from "@/lib/solana-exec";
import { SolanaExecTable } from "@/components/solana-exec-table";

type Chain = "solana" | "ethereum" | "bsc" | "base";

const TABS: { key: Chain; label: string }[] = [
  { key: "solana", label: "Solana" },
  { key: "ethereum", label: "Ethereum" },
  { key: "bsc", label: "BSC" },
  { key: "base", label: "Base" },
];

function EVMChainView({
  chain,
  platforms,
}: {
  chain: string;
  platforms: EVMPlatformRow[];
}) {
  const withData = platforms.filter((p) => p.chains[chain]);

  if (withData.length === 0) {
    return (
      <div className="card rounded-xl py-12 text-center text-ink-muted text-sm">
        No data yet — collector is warming up.
      </div>
    );
  }

  const sorted = [...withData].sort((a, b) => {
    const aTotal = (a.chains[chain]?.stable24h ?? 0) + (a.chains[chain]?.native?.usd ?? 0);
    const bTotal = (b.chains[chain]?.stable24h ?? 0) + (b.chains[chain]?.native?.usd ?? 0);
    return bTotal - aTotal;
  });

  return (
    <div className="card rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rule">
              <th className="text-left py-3 pl-4 sm:pl-6 pr-4 font-medium text-ink-muted text-xs w-8">#</th>
              <th className="text-left py-3 pr-4 font-medium text-ink-muted text-xs">Platform</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs">Revenue 24h</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden sm:table-cell">USDC</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden sm:table-cell">Native</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden md:table-cell">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => {
              const data = row.chains[chain];
              if (!data) return null;
              const total = data.stable24h + (data.native?.usd ?? 0);

              return (
                <tr
                  key={row.platform}
                  className="border-b border-rule last:border-0 hover:bg-paper-soft transition-colors"
                >
                  <td className="py-4 pl-4 sm:pl-6 pr-3 text-ink-muted font-mono text-xs tabular-nums align-middle">
                    {i + 1}
                  </td>
                  <td className="py-4 pr-4 font-medium text-ink align-middle">
                    {PLATFORM_DISPLAY[row.platform] ?? row.platform}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono font-semibold text-ink tabular-nums align-middle">
                    {fmtUSD(total)}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-ink-soft tabular-nums align-middle hidden sm:table-cell">
                    {data.stable24h > 0 ? fmtUSD(data.stable24h) : <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-xs text-ink-soft tabular-nums align-middle hidden sm:table-cell">
                    {data.native
                      ? `${data.native.amount.toFixed(4)} ${data.native.symbol}`
                      : <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-xs align-middle hidden md:table-cell">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                      data.coverage === "full"
                        ? "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400"
                        : "bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400"
                    }`}>
                      {data.coverage === "full" ? "full" : "USDC only"}
                    </span>
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

export function ExecChainTabs({
  solanaData,
  evmData,
}: {
  solanaData: ExecLeaderboardResponse | null;
  evmData: EVMRevenueResponse | null;
}) {
  const [chain, setChain] = useState<Chain>("solana");

  return (
    <div>
      <div className="flex gap-1 border-b border-rule mb-6">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setChain(tab.key)}
            className={`px-3 py-2 text-sm font-mono border-b-2 transition-colors ${
              chain === tab.key
                ? "border-accent text-ink font-medium"
                : "border-transparent text-ink-muted hover:text-ink-soft"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {chain === "solana" && (
        <SolanaExecTable
          platforms={solanaData?.platforms ?? []}
          updatedAt={solanaData?.updatedAt ?? null}
        />
      )}

      {(chain === "ethereum" || chain === "bsc" || chain === "base") && (
        <EVMChainView
          chain={chain}
          platforms={evmData?.platforms ?? []}
        />
      )}
    </div>
  );
}
