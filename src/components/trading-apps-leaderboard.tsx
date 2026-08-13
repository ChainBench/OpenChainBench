"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { logoPath } from "@/lib/logo-manifest";
import type { AppMeta } from "@/lib/trading-apps-config";
import type { DLPlatformData } from "@/lib/defillama";

type FeeWindow = {
  solana: number | null;
  ethereum: number | null;
  bsc: number | null;
  base: number | null;
  robinhood: number | null;
  total: number;
};

export type UnifiedAppRow = {
  meta: AppMeta;
  windows: Record<string, FeeWindow>;
  stableOnly: { ethereum: boolean; bsc: boolean; base: boolean; robinhood: boolean };
  dl: DLPlatformData | null;
  marketSharePct: number | null;
};

type TabKey = "all" | "trading-terminal" | "telegram-bot";
type WindowKey = "24h" | "7d" | "30d";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "trading-terminal", label: "Trading Terminals" },
  { key: "telegram-bot", label: "Telegram Bots" },
];

const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

const CATEGORY_BADGE: Record<AppMeta["category"], string> = {
  "trading-terminal": "bg-orange-500/10 text-orange-400 border border-orange-500/20",
  "telegram-bot": "bg-blue-500/10 text-blue-400 border border-blue-500/20",
};

const FORM_FACTOR_ICON: Record<AppMeta["formFactor"], string> = {
  web: "🌐",
  mobile: "📱",
  telegram: "✈️",
};

const CATEGORY_LABEL: Record<AppMeta["category"], string> = {
  "trading-terminal": "Terminal",
  "telegram-bot": "Bot",
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
  hideBelow?: "md" | "lg";
};

const HIDE_CLASS: Record<NonNullable<ChainCellProps["hideBelow"]>, string> = {
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

function ChainCell({ value, stableOnly, hideBelow }: ChainCellProps) {
  const hide = hideBelow ? ` ${HIDE_CLASS[hideBelow]}` : "";
  if (value === null) {
    return (
      <td className={`py-4 pr-4 sm:pr-6 text-right font-mono tabular-nums align-middle text-ink-faint${hide}`}>
        <Dash />
      </td>
    );
  }
  return (
    <td className={`py-4 pr-4 sm:pr-6 text-right font-mono tabular-nums align-middle${hide}`}>
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
  fomoLatestDate,
  fomoRelayAvailable,
}: {
  rows: UnifiedAppRow[];
  updatedAt: string | null;
  fomoLatestDate: string | null;
  fomoRelayAvailable: boolean;
  activeDlTotal: number;
}) {
  const [tab, setTab] = useState<TabKey>("all");
  const [window, setWindow] = useState<WindowKey>("24h");

  const filtered = tab === "all" ? rows : rows.filter((r) => r.meta.category === tab);
  const sorted = [...filtered].sort((a, b) => {
    if (a.meta.inactive && !b.meta.inactive) return 1;
    if (!a.meta.inactive && b.meta.inactive) return -1;
    return (b.windows[window]?.total ?? 0) - (a.windows[window]?.total ?? 0);
  });

  const hasStableOnly = sorted.some(
    (r) => r.stableOnly.ethereum || r.stableOnly.bsc || r.stableOnly.base || r.stableOnly.robinhood
  );

  // Any active platform with >50% daily swing makes Share numbers unreliable for the whole cohort
  const hasExtremeMove = sorted.some(
    (r) => !r.meta.inactive && r.dl && Math.abs(r.dl.change_1d ?? 0) > 50
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
        <div className="flex items-center gap-3 pb-2">
          <div className="flex gap-0.5 bg-paper-soft rounded-md p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                type="button"
                onClick={() => setWindow(w.key)}
                className={`px-2.5 py-1 text-xs font-mono rounded transition-colors ${
                  window === w.key
                    ? "bg-paper text-ink shadow-sm"
                    : "text-ink-muted hover:text-ink-soft"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          {updatedAt && (
            <span className="text-[11px] text-ink-faint font-mono">
              {new Date(updatedAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rule">
              <th className="text-left py-3 pl-4 sm:pl-6 pr-3 font-medium text-ink-muted text-xs w-8">#</th>
              <th className="text-left py-3 pr-4 font-medium text-ink-muted text-xs">App</th>
              <th className="text-left py-3 pr-4 font-medium text-ink-muted text-xs hidden sm:table-cell">Type</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs">
                <Link href="/benchmarks/memecoin-platforms" className="hover:text-ink-soft transition-colors underline decoration-dotted">
                  Solana
                </Link>
              </th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden md:table-cell">ETH/BSC/Base</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden lg:table-cell" title="Net revenue per DeFiLlama (fees minus referral/cashback)">DL Rev</th>
              <th
                className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden lg:table-cell"
                title={hasExtremeMove ? "Share distorted — at least one platform has a >50% daily swing (possible data gap)" : undefined}
              >
                Share{hasExtremeMove ? " ⚠" : ""}
              </th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs">
                Total {window}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => {
              const { meta, dl, marketSharePct } = row;
              const fees = row.windows[window] ?? { solana: null, ethereum: null, bsc: null, base: null, robinhood: null, total: 0 };
              const logo = meta.logoKey ? logoPath(meta.logoKey) : null;
              const evmTotal = (fees.ethereum ?? 0) + (fees.bsc ?? 0) + (fees.base ?? 0) + (fees.robinhood ?? 0);

              return (
                <tr
                  key={meta.id}
                  className={`border-b border-rule last:border-0 hover:bg-paper-soft transition-colors ${meta.inactive ? "opacity-50" : ""}`}
                >
                  <td className="py-4 pl-4 sm:pl-6 pr-3 text-ink-muted font-mono text-xs tabular-nums align-middle">
                    {i + 1}
                  </td>
                  <td className="py-4 pr-4 align-middle">
                    <div className="flex items-center gap-2.5">
                      <Link
                        href={meta.benchUrl ?? meta.productUrl}
                        {...(!meta.benchUrl ? { target: "_blank", rel: "noopener noreferrer" } : {})}
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
                      </Link>
                      {meta.inactive && (
                        <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-400 border border-red-500/20 shrink-0" title={`Trading suspended since ${meta.inactiveSince}`}>
                          Suspended
                        </span>
                      )}
                      {dl?.change_1d !== null && dl?.change_1d !== undefined && !meta.inactive && dl.total24h >= 5000 && (
                        (() => {
                          const extreme = Math.abs(dl.change_1d) > 50;
                          return (
                            <span
                              className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-mono tabular-nums shrink-0 ${
                                extreme
                                  ? "text-amber-400/80 bg-amber-500/10"
                                  : dl.change_1d >= 0
                                  ? "text-green-400 bg-green-500/10"
                                  : "text-red-400 bg-red-500/10"
                              }`}
                              title={extreme ? "Large move — possible data ingestion gap, not verified" : "DeFiLlama revenue 24h vs prior 24h"}
                            >
                              {extreme ? "⚠ " : dl.change_1d >= 0 ? "+" : ""}{dl.change_1d.toFixed(1)}%
                            </span>
                          );
                        })()
                      )}
                      {meta.benchUrl && (
                        <a
                          href={meta.productUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-ink-faint hover:text-ink-muted transition-colors"
                          title={`Visit ${meta.name}`}
                        >
                          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                            <path d="M3.5 3H2a1 1 0 00-1 1v6a1 1 0 001 1h6a1 1 0 001-1V8.5M7 1h4m0 0v4m0-4L5.5 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="py-4 pr-4 align-middle hidden sm:table-cell">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm" title={meta.formFactor}>{FORM_FACTOR_ICON[meta.formFactor]}</span>
                      <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-medium ${CATEGORY_BADGE[meta.category]}`}>
                        {CATEGORY_LABEL[meta.category]}
                      </span>
                    </div>
                  </td>
                  <ChainCell value={fees.solana} />
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono tabular-nums align-middle hidden md:table-cell">
                    {evmTotal > 0 ? (
                      <span className="text-ink">{fmtUSD(evmTotal)}</span>
                    ) : <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono tabular-nums align-middle hidden lg:table-cell">
                    {dl && !meta.inactive ? (
                      <span className="text-ink-soft">
                        {fmtUSD(dl.total24h)}
                        {meta.defillamaScope === "venue" && (
                          <sup className="ml-0.5 text-[10px] text-ink-muted font-normal" title="Venue-level: includes creator/cashback fees not retained by the platform">²</sup>
                        )}
                      </span>
                    ) : <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right align-middle hidden lg:table-cell">
                    {marketSharePct !== null ? (
                      (() => {
                        const rowExtreme = !meta.inactive && dl && Math.abs(dl.change_1d ?? 0) > 50;
                        return rowExtreme ? (
                          <span className="font-mono text-xs text-amber-400/60 tabular-nums" title="Share unreliable — data gap suspected">⚠</span>
                        ) : (
                          <div className="flex items-center justify-end gap-1.5">
                            <div className="w-12 h-1.5 rounded-full bg-paper-soft overflow-hidden">
                              <div
                                className="h-full rounded-full bg-accent/60"
                                style={{ width: `${Math.min(marketSharePct, 100)}%` }}
                              />
                            </div>
                            <span className={`font-mono text-xs tabular-nums w-8 text-right ${hasExtremeMove ? "text-amber-400/60" : "text-ink-muted"}`}>
                              {marketSharePct.toFixed(1)}%
                            </span>
                          </div>
                        );
                      })()
                    ) : <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono font-semibold text-ink tabular-nums align-middle">
                    {fees.total > 0 ? fmtUSD(fees.total) : <Dash />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hasStableOnly && (
        <p className="px-4 sm:px-6 py-2.5 text-[11px] text-ink-faint border-t border-rule">
          <sup>°</sup> USDC only — native ETH/BNB not traceable for this platform.
          {window !== "24h" && " EVM 7d/30d shows USDC only; native ETH/BNB added for 24h."}
        </p>
      )}
      {!hasStableOnly && window !== "24h" && (
        <p className="px-4 sm:px-6 py-2.5 text-[11px] text-ink-faint border-t border-rule">
          EVM 7d/30d shows USDC only; native ETH/BNB added for 24h.
        </p>
      )}
      {fomoRelayAvailable && window === "24h" && (
        <p className="px-4 sm:px-6 py-2.5 text-[11px] text-ink-faint border-t border-rule">
          FOMO 24h relay = fees since midnight UTC (calendar day), not rolling window.
        </p>
      )}
      {!fomoRelayAvailable && (
        <p className="px-4 sm:px-6 py-2.5 text-[11px] border-t border-rule text-amber-400/80">
          FOMO relay data unavailable — showing on-chain fees only (~4% of actual revenue).
        </p>
      )}
      <FOMODataNotice latestDate={fomoLatestDate} />
      <p className="px-4 sm:px-6 py-2.5 text-[11px] text-ink-faint border-t border-rule">
        DL Rev = net revenue per DeFiLlama (fees minus referral/cashback). <sup>²</sup> Venue-level: bonding curve + creator slice, not frontend-only.
      </p>
    </div>
  );
}

function FOMODataNotice({ latestDate }: { latestDate: string | null }) {
  if (!latestDate) return null;
  const ageHours = (Date.now() - new Date(latestDate).getTime()) / 3_600_000;
  if (ageHours <= 36) return null;
  return (
    <p className="px-4 sm:px-6 py-2.5 text-[11px] border-t border-rule text-amber-400/80">
      FOMO relay data last updated {Math.round(ageHours)}h ago — figures may be stale.
    </p>
  );
}
