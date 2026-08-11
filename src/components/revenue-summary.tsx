"use client";

import type { EVMPlatformRow, EVMRevenueResponse } from "@/lib/evm-exec";
import {
  EVM_CHAINS,
  CHAIN_LABELS,
  fmtUSD,
  totalRevenue24h,
} from "@/lib/evm-exec";
import { PLATFORM_DISPLAY } from "@/lib/solana-exec";
import Image from "next/image";
import { logoPath } from "@/lib/logo-manifest";

const LOGO_KEY: Record<string, string> = {
  gmgn: "gmgn",
};

function Dash() {
  return <span className="text-ink-faint">—</span>;
}

function ChainCell({ row, chain }: { row: EVMPlatformRow; chain: string }) {
  const data = row.chains[chain];
  if (!data) return <td className="py-4 pr-4 text-right font-mono text-ink-muted tabular-nums"><Dash /></td>;

  const usd = data.stable24h + (data.native?.usd ?? 0);
  const isPartial = data.coverage === "stable-only";

  return (
    <td className="py-4 pr-4 sm:pr-6 text-right font-mono tabular-nums align-middle">
      <span className={usd > 0 ? "text-ink font-semibold" : "text-ink-muted"}>
        {fmtUSD(usd)}
        {isPartial && usd > 0 && (
          <sup className="ml-0.5 text-[10px] text-ink-muted font-normal">°</sup>
        )}
      </span>
    </td>
  );
}

export function RevenueSummary({
  evm,
}: {
  evm: EVMRevenueResponse | null;
}) {
  if (!evm || evm.platforms.length === 0) return null;

  const sorted = [...evm.platforms].sort(
    (a, b) => totalRevenue24h(b) - totalRevenue24h(a),
  );

  return (
    <div className="card rounded-xl overflow-hidden">
      <div className="px-4 sm:px-6 py-3 border-b border-rule flex items-center justify-between">
        <h2 className="text-sm font-medium text-ink">Revenue — last 24h</h2>
        {evm.updatedAt && (
          <span className="text-[11px] text-ink-faint font-mono">
            {new Date(evm.updatedAt).toLocaleString()}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rule">
              <th className="text-left py-3 pl-4 sm:pl-6 pr-4 font-medium text-ink-muted text-xs">
                Platform
              </th>
              {EVM_CHAINS.map((chain) => (
                <th
                  key={chain}
                  className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs"
                >
                  {CHAIN_LABELS[chain]}
                </th>
              ))}
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const logo = logoPath(LOGO_KEY[row.platform] ?? row.platform);
              const total = totalRevenue24h(row);

              return (
                <tr
                  key={row.platform}
                  className="border-b border-rule last:border-0 hover:bg-paper-soft transition-colors"
                >
                  <td className="py-4 pl-4 sm:pl-6 pr-4 align-middle">
                    <div className="flex items-center gap-2.5">
                      {logo && (
                        <Image
                          src={logo}
                          alt={PLATFORM_DISPLAY[row.platform] ?? row.platform}
                          width={22}
                          height={22}
                          className="rounded-full shrink-0 object-contain bg-paper-soft"
                        />
                      )}
                      <span className="font-medium text-ink">
                        {PLATFORM_DISPLAY[row.platform] ?? row.platform}
                      </span>
                    </div>
                  </td>
                  {EVM_CHAINS.map((chain) => (
                    <ChainCell key={chain} row={row} chain={chain} />
                  ))}
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono font-semibold text-ink tabular-nums align-middle">
                    {fmtUSD(total)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="px-4 sm:px-6 py-2.5 text-[11px] text-ink-faint border-t border-rule">
        <sup>°</sup> USDC only — native ETH not tracked on Base (no free trace API).
        Solana revenue column pending exact measurement.
      </p>
    </div>
  );
}
