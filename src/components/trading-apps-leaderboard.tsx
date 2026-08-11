"use client";

import Image from "next/image";
import { useState } from "react";
import { logoPath } from "@/lib/logo-manifest";
import type { AppMeta } from "@/lib/trading-apps-config";

export type UnifiedAppRow = {
  meta: AppMeta;
  fees: {
    solana: number | null;
    ethereum: number | null;
    bsc: number | null;
    base: number | null;
  };
  stableOnly: { ethereum: boolean; bsc: boolean; base: boolean };
  total24h: number;
};

type TabKey = "all" | "meme-bot" | "telegram-bot";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "meme-bot", label: "Meme Bots" },
  { key: "telegram-bot", label: "Telegram Bots" },
];

const CATEGORY_BADGE: Record<AppMeta["category"], string> = {
  "meme-bot": "bg-orange-500/10 text-orange-400 border border-orange-500/20",
  "telegram-bot": "bg-blue-500/10 text-blue-400 border border-blue-500/20",
};

const CATEGORY_LABEL: Record<AppMeta["category"], string> = {
  "meme-bot": "Meme Bot",
  "telegram-bot": "Telegram Bot",
};

function fmtUSD(n: number | null): string {
  if (n === null || n === 0) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function Dash() {
  return <span className="text-ink-faint">—</span>;
}

type ChainCellProps = {
  value: number | null;
  stableOnly?: boolean;
};

function ChainCell({ value, stableOnly }: ChainCellProps) {
  if (value === null) {
    return (
      <td className="py-4 pr-4 sm:pr-6 text-right font-mono tabular-nums align-middle text-ink-faint">
        <Dash />
      </td>
    );
  }
  return (
    <td className="py-4 pr-4 sm:pr-6 text-right font-mono tabular-nums align-middle">
      <span className={value > 0 ? "text-ink" : "text-ink-muted"}>
        {fmtUSD(value)}
        {stableOnly && value > 0 && (
          <sup className="ml-0.5 text-[10px] text-ink-muted font-normal">°</sup>
        )}
      </span>
    </td>
  );
}

export function TradingAppsLeaderboard({
  rows,
  updatedAt,
}: {
  rows: UnifiedAppRow[];
  updatedAt: string | null;
}) {
  const [tab, setTab] = useState<TabKey>("all");

  const filtered = tab === "all" ? rows : rows.filter((r) => r.meta.category === tab);
  const sorted = [...filtered].sort((a, b) => b.total24h - a.total24h);

  const hasStableOnly = sorted.some(
    (r) => r.stableOnly.ethereum || r.stableOnly.bsc || r.stableOnly.base
  );

  return (
    <div className="card rounded-xl overflow-hidden">
      <div className="px-4 sm:px-6 pt-4 pb-0 flex items-end justify-between gap-4 flex-wrap border-b border-rule">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-3 py-2 text-sm font-mono border-b-2 transition-colors ${
                tab === t.key
                  ? "border-accent text-ink font-medium"
                  : "border-transparent text-ink-muted hover:text-ink-soft"
              }`}
            >
              {t.label}
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
              <th className="text-left py-3 pr-4 font-medium text-ink-muted text-xs">App</th>
              <th className="text-left py-3 pr-4 font-medium text-ink-muted text-xs hidden sm:table-cell">Category</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs">Solana</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden md:table-cell">Ethereum</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden md:table-cell">BSC</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden md:table-cell">Base</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs">Total 24h</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => {
              const { meta, fees, stableOnly } = row;
              const logo = meta.logoKey ? logoPath(meta.logoKey) : null;

              return (
                <tr
                  key={meta.id}
                  className="border-b border-rule last:border-0 hover:bg-paper-soft transition-colors"
                >
                  <td className="py-4 pl-4 sm:pl-6 pr-3 text-ink-muted font-mono text-xs tabular-nums align-middle">
                    {i + 1}
                  </td>
                  <td className="py-4 pr-4 align-middle">
                    <a
                      href={meta.productUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2.5 hover:opacity-80 transition-opacity"
                    >
                      {logo && (
                        <Image
                          src={logo}
                          alt={meta.name}
                          width={22}
                          height={22}
                          className="rounded-full shrink-0 object-contain bg-paper-soft"
                        />
                      )}
                      <span className="font-medium text-ink">{meta.name}</span>
                    </a>
                  </td>
                  <td className="py-4 pr-4 align-middle hidden sm:table-cell">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-medium ${CATEGORY_BADGE[meta.category]}`}>
                      {CATEGORY_LABEL[meta.category]}
                    </span>
                  </td>
                  <ChainCell value={fees.solana} />
                  <ChainCell value={fees.ethereum} stableOnly={stableOnly.ethereum} />
                  <ChainCell value={fees.bsc} stableOnly={stableOnly.bsc} />
                  <ChainCell value={fees.base} stableOnly={stableOnly.base} />
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono font-semibold text-ink tabular-nums align-middle">
                    {row.total24h > 0 ? fmtUSD(row.total24h) : <Dash />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hasStableOnly && (
        <p className="px-4 sm:px-6 py-2.5 text-[11px] text-ink-faint border-t border-rule">
          <sup>°</sup> USDC only (no native trace on Base).
        </p>
      )}
    </div>
  );
}
