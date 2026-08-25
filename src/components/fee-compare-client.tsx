"use client";

import { useState } from "react";
import Image from "next/image";
import {
  ArrowRight,
  Loader2,
  AlertCircle,
  Zap,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

type FillRow = {
  time: number;
  coin: string;
  dir: string;
  side: string;
  notional: number;
  hlFee: number;
  closedPnl: number;
  isTaker: boolean;
  gainsPerSide: number | null;
};

type TopCoin = {
  coin: string;
  fills: number;
  notional: number;
  fees: number;
  onGains: boolean;
  gainsRoundTripRate: number | null;
};

type FeeCompareResult = {
  wallet: string;
  days: number;
  hl: {
    fills: number;
    notionalUsd: number;
    feesUsd: number;
    fundingUsd: number;
    netCostUsd: number;
    avgFeeRateBps: number;
    topCoins: TopCoin[];
    recentFills: FillRow[];
  };
  gains: {
    events: number;
    feesUsdc: number;
    positionSizeUsdc: number;
    avgFeeRateBps: number;
  };
  comparison: {
    hlNotionalOnGains: number;
    hlFeesOnGainsCoins: number;
    gainsEquivForHlNotional: number;
    hlSavedVsGains: number;
    hlCheaperMultiple: number | null;
    hlRoundTripRate: number;
    hlEquivForGainsVolume: number;
    gainsSavedVsHl: number;
  };
  gainsFeeRates: Record<string, number>;
};

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtUsd(n: number) {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1000) return sign + "$" + fmt(abs, 0);
  return sign + "$" + fmt(abs, 2);
}

function fmtBps(rate: number) {
  return fmt(rate * 10000, 2) + " bps";
}

function fmtDate(ms: number) {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ──────────────────────────────────────────────────────────────────────
// Atoms
// ──────────────────────────────────────────────────────────────────────

function PlatformLogo({ name, size = 28 }: { name: "hl" | "gains"; size?: number }) {
  return (
    <Image
      src={name === "hl" ? "/logos/hyperliquid.png" : "/logos/gains.png"}
      alt={name === "hl" ? "Hyperliquid" : "Gains"}
      width={size}
      height={size}
      className="rounded-full object-cover shrink-0"
    />
  );
}

function DirBadge({ dir }: { dir: string }) {
  const d = dir.toLowerCase();
  const isOpen = d.includes("open");
  const isLong = d.includes("long");
  const cls = isOpen
    ? isLong ? "bg-emerald-500/12 text-emerald-500" : "bg-red-400/12 text-red-400"
    : isLong ? "bg-emerald-500/8 text-emerald-500/60" : "bg-red-400/8 text-red-400/60";
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${cls}`}>
      {dir}
    </span>
  );
}

function MakerBadge() {
  return (
    <span className="inline-flex rounded-md bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-amber-500">
      maker
    </span>
  );
}

function CheaperBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-500">
      <Zap size={9} strokeWidth={2.5} />
      Cheaper
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────
// SummaryVsCard — always shows both platforms, simulated if needed
// ──────────────────────────────────────────────────────────────────────

function SummaryVsCard({ result }: { result: FeeCompareResult }) {
  const { hl, gains, comparison } = result;
  const hasHl = hl.fills > 0;
  const hasGains = gains.events > 0;

  // Determine what to show on the Gains side
  // If no real Gains activity, use simulated cost for HL trades
  const gainsDisplay = hasGains
    ? { fee: gains.feesUsdc, bps: gains.avgFeeRateBps, real: true, label: `${gains.events} trades` }
    : hasHl && comparison.gainsEquivForHlNotional > 0
      ? {
          fee: comparison.gainsEquivForHlNotional,
          bps: comparison.hlNotionalOnGains > 0
            ? (comparison.gainsEquivForHlNotional / comparison.hlNotionalOnGains) * 10000
            : 0,
          real: false,
          label: "simulated",
        }
      : null;

  // Winner logic — compare what was actually paid vs equiv on the other platform
  const hlFeeComp = comparison.hlFeesOnGainsCoins > 0 ? comparison.hlFeesOnGainsCoins : hl.feesUsd;
  const gainsFeeComp = gainsDisplay?.fee ?? 0;
  const diff = Math.abs(hlFeeComp - gainsFeeComp);
  const hlWins = gainsFeeComp > 0 && hlFeeComp < gainsFeeComp && diff > 0.5;
  const gainsWins = gainsFeeComp > 0 && gainsFeeComp < hlFeeComp && diff > 0.5;

  if (!hasHl && !hasGains) {
    return (
      <div className="card-soft rounded-2xl p-8 text-center">
        <p className="text-ink-soft">No trades found in the last {result.days} days on either platform.</p>
      </div>
    );
  }

  return (
    <div className="card-soft rounded-2xl overflow-hidden">
      {/* Mobile: stacked. Desktop: side-by-side */}
      <div className="flex flex-col sm:grid sm:grid-cols-[1fr_auto_1fr]">
        {/* Hyperliquid side */}
        <div className={`p-5 sm:p-6 ${hlWins ? "bg-emerald-500/4" : ""}`}>
          <div className="flex items-center gap-2.5 mb-4">
            <PlatformLogo name="hl" size={28} />
            <div>
              <p className="font-bold text-sm text-ink">Hyperliquid</p>
              {hasHl && <p className="text-[11px] text-ink-faint mt-0.5">{hl.fills} fills</p>}
            </div>
            {hlWins && <span className="ml-auto"><CheaperBadge /></span>}
          </div>

          {hasHl ? (
            <div className="space-y-3">
              <div>
                <p className={`font-mono text-3xl sm:text-4xl font-extrabold tracking-tight leading-none ${hlWins ? "text-emerald-500" : "text-ink"}`}>
                  {fmtUsd(hl.feesUsd)}
                </p>
                <p className="text-xs text-ink-faint mt-1.5">{fmt(hl.avgFeeRateBps, 2)} bps avg rate</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-ink/4 rounded-xl p-3">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Volume</p>
                  <p className="font-mono font-semibold text-ink mt-1 text-sm">{fmtUsd(hl.notionalUsd)}</p>
                </div>
                <div className="bg-ink/4 rounded-xl p-3">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Net cost</p>
                  <p className="font-mono font-semibold text-ink mt-1 text-sm">{fmtUsd(hl.netCostUsd)}</p>
                  <p className="text-[10px] text-ink-faint/60 mt-0.5">after funding</p>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink-faint">No Hyperliquid activity</p>
          )}
        </div>

        {/* VS divider — horizontal on mobile, vertical on desktop */}
        <div className="flex sm:flex-col items-center justify-center sm:px-3 py-3 sm:py-0">
          <div className="flex-1 sm:flex-none h-px sm:h-auto sm:w-px bg-ink/10 sm:flex-1" />
          <div className="rounded-full border border-ink/15 bg-paper px-2.5 py-1 mx-3 sm:mx-0 sm:my-2">
            <span className="font-mono text-[11px] font-bold text-ink-faint">VS</span>
          </div>
          <div className="flex-1 sm:flex-none h-px sm:h-auto sm:w-px bg-ink/10 sm:flex-1" />
        </div>

        {/* Gains side */}
        <div className={`p-5 sm:p-6 ${gainsWins ? "bg-emerald-500/4" : ""}`}>
          <div className="flex items-center gap-2.5 mb-5">
            <PlatformLogo name="gains" size={32} />
            <div>
              <p className="font-bold text-sm text-ink">Gains</p>
              {gainsDisplay && (
                <p className="text-[11px] text-ink-faint mt-0.5">
                  {gainsDisplay.label}
                  {!gainsDisplay.real && (
                    <span className="ml-1 text-ink-faint/50">· est.</span>
                  )}
                </p>
              )}
            </div>
            {gainsWins && <span className="ml-auto"><CheaperBadge /></span>}
          </div>

          {gainsDisplay ? (
            <div className="space-y-3">
              <div>
                <p className={`font-mono text-3xl sm:text-4xl font-extrabold tracking-tight leading-none ${gainsWins ? "text-emerald-500" : "text-ink"}`}>
                  {fmtUsd(gainsDisplay.fee)}
                </p>
                <p className="text-xs text-ink-faint mt-1.5">
                  {fmt(gainsDisplay.bps, 2)} bps avg rate
                  {!gainsDisplay.real && " · live schedule"}
                </p>
              </div>
              {!gainsDisplay.real && hasHl && (
                <div className="bg-ink/4 rounded-xl p-3">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Same volume on Gains</p>
                  <p className="font-mono font-semibold text-ink mt-1 text-sm">{fmtUsd(comparison.hlNotionalOnGains)}</p>
                  <p className="text-[10px] text-ink-faint/60 mt-0.5">
                    {comparison.hlNotionalOnGains < hl.notionalUsd ? "Gains-listed coins only" : "all coins"}
                  </p>
                </div>
              )}
              {gainsDisplay.real && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-ink/4 rounded-xl p-3">
                    <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Volume</p>
                    <p className="font-mono font-semibold text-ink mt-1 text-sm">{fmtUsd(gains.positionSizeUsdc)}</p>
                  </div>
                  <div className="bg-ink/4 rounded-xl p-3">
                    <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Events</p>
                    <p className="font-mono font-semibold text-ink mt-1 text-sm">{gains.events}</p>
                    <p className="text-[10px] text-ink-faint/60 mt-0.5">USDC collateral</p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-ink-faint">No Gains activity</p>
          )}
        </div>
      </div>

      {/* Verdict bar */}
      <div className="border-t border-ink/8 px-5 sm:px-6 py-4">
        {hasHl && comparison.hlNotionalOnGains > 0 && (
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <p className="text-xs text-ink-soft">
              Same trades at live Gains rates
              {comparison.hlNotionalOnGains < hl.notionalUsd && " (Gains-listed coins only)"}
            </p>
            {comparison.hlSavedVsGains > 0.5 ? (
              <p className="font-mono font-bold text-emerald-500 text-sm">
                Hyperliquid saved {fmtUsd(comparison.hlSavedVsGains)}
                {comparison.hlCheaperMultiple && comparison.hlCheaperMultiple > 1.05 && (
                  <span className="font-normal text-emerald-500/70 text-xs ml-1.5">
                    ({fmt(comparison.hlCheaperMultiple, 1)}x cheaper)
                  </span>
                )}
              </p>
            ) : comparison.hlSavedVsGains < -0.5 ? (
              <p className="font-mono font-bold text-red-400 text-sm">
                Gains would save {fmtUsd(Math.abs(comparison.hlSavedVsGains))}
              </p>
            ) : (
              <p className="text-xs text-ink-faint font-medium">Roughly equal cost</p>
            )}
          </div>
        )}
        {hasGains && (
          <div className={`flex items-center justify-between gap-4 flex-wrap ${hasHl && comparison.hlNotionalOnGains > 0 ? "mt-3 pt-3 border-t border-ink/6" : ""}`}>
            <p className="text-xs text-ink-soft">
              Same Gains volume at Hyperliquid taker ({fmtBps(comparison.hlRoundTripRate)} RT)
            </p>
            {comparison.gainsSavedVsHl < -0.5 ? (
              <p className="font-mono font-bold text-emerald-500 text-sm">
                Hyperliquid saves {fmtUsd(Math.abs(comparison.gainsSavedVsHl))}
              </p>
            ) : comparison.gainsSavedVsHl > 0.5 ? (
              <p className="font-mono font-bold text-red-400 text-sm">
                Gains overpaid {fmtUsd(comparison.gainsSavedVsHl)} vs Hyperliquid
              </p>
            ) : (
              <p className="text-xs text-ink-faint font-medium">Roughly equal cost</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// TopCoinsCard
// ──────────────────────────────────────────────────────────────────────

function TopCoinsCard({ topCoins }: { topCoins: TopCoin[] }) {
  if (topCoins.length === 0) return null;
  return (
    <div className="card-soft rounded-2xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-ink/8">
        <PlatformLogo name="hl" size={20} />
        <p className="font-bold text-sm text-ink">Top markets</p>
      </div>
      <div className="divide-y divide-ink/5">
        {topCoins.map((c) => (
          <div key={c.coin} className="flex items-center gap-3 px-5 py-3 hover:bg-ink/2 transition-colors">
            <span className="font-mono text-sm font-bold text-ink w-12 shrink-0">{c.coin}</span>
            <span className="text-xs text-ink-faint w-14 shrink-0 hidden sm:block">{c.fills} fills</span>
            <div className="flex-1 min-w-0 hidden sm:block">
              <div className="h-1 rounded-full bg-ink/8 overflow-hidden">
                <div
                  className="h-full rounded-full bg-ink/25"
                  style={{ width: `${Math.min(100, (c.notional / topCoins[0].notional) * 100)}%` }}
                />
              </div>
            </div>
            <span className="font-mono text-xs text-ink-soft text-right shrink-0 flex-1 sm:flex-none sm:w-20">{fmtUsd(c.notional)}</span>
            <span className="font-mono text-xs font-bold text-ink w-16 text-right shrink-0">{fmtUsd(c.fees)}</span>
            {c.gainsRoundTripRate !== null ? (
              <span className="text-[10px] text-ink-faint w-20 sm:w-28 text-right shrink-0 font-mono">
                {fmtBps(c.gainsRoundTripRate)} RT
              </span>
            ) : (
              <span className="text-[10px] text-ink-faint/30 w-20 sm:w-28 text-right shrink-0 hidden sm:block">not on Gains</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// HlTradeTable — bold the cheaper fee per row
// ──────────────────────────────────────────────────────────────────────

function HlTradeTable({ fills }: { fills: FillRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const PREVIEW = 10;
  const rows = showAll ? fills : fills.slice(0, PREVIEW);

  if (fills.length === 0) return null;

  return (
    <div className="card-soft rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-ink/8">
        <div className="flex items-center gap-2.5">
          <PlatformLogo name="hl" size={20} />
          <p className="font-bold text-sm text-ink">Trade history</p>
        </div>
        <p className="text-xs text-ink-faint">{fills.length} fills</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink/8 text-left bg-ink/2">
              <th className="px-5 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium">Date</th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium">Market</th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium hidden sm:table-cell">Direction</th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right hidden sm:table-cell">Notional</th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right">HL fee</th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right hidden md:table-cell">Gains fee</th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right hidden md:table-cell">Saved</th>
              <th className="px-5 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right hidden md:table-cell">PnL</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => {
              const gainsFee = f.gainsPerSide;
              const saved = gainsFee !== null ? gainsFee - f.hlFee : null;
              const hlCheaper = gainsFee !== null && f.hlFee < gainsFee && Math.abs(f.hlFee - gainsFee) > 0.001;
              const gainsCheaper = gainsFee !== null && gainsFee < f.hlFee && Math.abs(f.hlFee - gainsFee) > 0.001;
              const isOpen = f.closedPnl === 0 && !f.dir.toLowerCase().includes("close");

              return (
                <tr key={i} className="border-b border-ink/5 last:border-0 hover:bg-ink/2 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-ink-faint whitespace-nowrap">{fmtDate(f.time)}</td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs font-bold text-ink">{f.coin}</span>
                      {!f.isTaker && <MakerBadge />}
                    </div>
                  </td>
                  <td className="px-3 py-3 hidden sm:table-cell"><DirBadge dir={f.dir} /></td>
                  <td className="px-3 py-3 text-right font-mono text-xs text-ink-soft hidden sm:table-cell">{fmtUsd(f.notional)}</td>

                  {/* HL fee — bold green if cheaper */}
                  <td className={`px-3 py-3 text-right font-mono text-xs font-bold ${hlCheaper ? "text-emerald-500" : "text-ink"}`}>
                    {fmtUsd(f.hlFee)}
                  </td>

                  {/* Gains fee — bold green if cheaper */}
                  <td className={`px-3 py-3 text-right font-mono text-xs font-bold hidden md:table-cell ${gainsCheaper ? "text-emerald-500" : "text-ink-soft"}`}>
                    {gainsFee !== null ? fmtUsd(gainsFee) : <span className="text-ink-faint/30 font-normal">—</span>}
                  </td>

                  <td className="px-3 py-3 text-right font-mono text-xs hidden md:table-cell">
                    {saved !== null ? (
                      saved > 0.001 ? (
                        <span className="text-emerald-500 font-semibold">+{fmtUsd(saved)}</span>
                      ) : saved < -0.001 ? (
                        <span className="text-red-400 font-semibold">{fmtUsd(saved)}</span>
                      ) : (
                        <span className="text-ink-faint/40">≈ 0</span>
                      )
                    ) : <span className="text-ink-faint/30">—</span>}
                  </td>

                  <td className="px-5 py-3 text-right font-mono text-xs hidden md:table-cell">
                    {isOpen ? (
                      <span className="text-[10px] text-ink-faint/40">open</span>
                    ) : f.closedPnl > 0 ? (
                      <span className="text-emerald-500 font-semibold">+{fmtUsd(f.closedPnl)}</span>
                    ) : f.closedPnl < 0 ? (
                      <span className="text-red-400 font-semibold">{fmtUsd(f.closedPnl)}</span>
                    ) : (
                      <span className="text-ink-faint/30">$0</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {fills.length > PREVIEW && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="flex w-full items-center justify-center gap-1.5 border-t border-ink/8 py-3.5 text-xs text-ink-faint hover:text-ink transition-colors font-medium"
        >
          {showAll ? <><ChevronUp size={13} />Show less</> : <><ChevronDown size={13} />Show all {fills.length} trades</>}
        </button>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// GainsCard
// ──────────────────────────────────────────────────────────────────────

function GainsCard({ gains, comparison }: { gains: FeeCompareResult["gains"]; comparison: FeeCompareResult["comparison"] }) {
  const hlSaves = comparison.gainsSavedVsHl < -0.5;
  return (
    <div className="card-soft rounded-2xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-ink/8">
        <PlatformLogo name="gains" size={20} />
        <p className="font-bold text-sm text-ink">Gains on-chain</p>
        <span className="ml-auto text-[10px] font-mono text-ink-faint">Arbitrum</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-ink/8">
        {[
          { label: "Fees paid", value: fmtUsd(gains.feesUsdc), sub: fmt(gains.avgFeeRateBps, 2) + " bps avg" },
          { label: "Volume", value: fmtUsd(gains.positionSizeUsdc), sub: `${gains.events} events` },
          { label: "Hyperliquid equiv", value: fmtUsd(comparison.hlEquivForGainsVolume), sub: fmtBps(comparison.hlRoundTripRate) + " taker RT", winner: hlSaves },
          {
            label: hlSaves ? "Hyperliquid saves" : "Gains saves",
            value: Math.abs(comparison.gainsSavedVsHl) > 0.5 ? fmtUsd(Math.abs(comparison.gainsSavedVsHl)) : "≈ $0",
            accent: true,
            winner: false,
          },
        ].map((s) => (
          <div key={s.label} className={`bg-paper p-4 ${s.winner ? "bg-emerald-500/4" : ""}`}>
            <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint">{s.label}</p>
            <p className={`font-mono text-xl font-bold mt-1 ${s.accent ? (hlSaves ? "text-emerald-500" : "text-red-400") : "text-ink"}`}>{s.value}</p>
            {s.sub && <p className="font-sans text-xs text-ink-muted mt-0.5">{s.sub}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Results
// ──────────────────────────────────────────────────────────────────────

function Results({ result }: { result: FeeCompareResult }) {
  return (
    <div className="space-y-4">
      <SummaryVsCard result={result} />
      {result.hl.topCoins.length > 0 && <TopCoinsCard topCoins={result.hl.topCoins} />}
      {result.hl.recentFills.length > 0 && <HlTradeTable fills={result.hl.recentFills} />}
      {result.gains.events > 0 && <GainsCard gains={result.gains} comparison={result.comparison} />}
      <p className="text-[11px] text-ink-faint px-1 leading-relaxed">
        Hyperliquid fees: exact fills from Hyperliquid API. Gains fees: on-chain{" "}
        <code className="font-mono text-[10px]">FeesProcessed</code> events from{" "}
        <code className="font-mono text-[10px]">0xFF16...7f169</code> (Arbitrum). Simulated Gains costs use
        live rates from <code className="font-mono text-[10px]">backend-arbitrum.gains.trade</code>.
        Hyperliquid simulation uses official taker rate (3.5 bps/side). Funding and borrowing fees excluded.
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// FeeCompareClient
// ──────────────────────────────────────────────────────────────────────

export function FeeCompareClient() {
  const [wallet, setWallet] = useState("");
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FeeCompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    const trimmed = wallet.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      setError("Enter a valid Ethereum address (0x...)");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/fee-compare?wallet=${encodeURIComponent(trimmed)}&days=${days}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setError(res.status === 429 ? "Rate limited — wait a moment and try again." : (d.error ?? "Something went wrong."));
        return;
      }
      setResult(await res.json() as FeeCompareResult);
    } catch {
      setError("Network error — check your connection.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="card-soft rounded-2xl p-5 space-y-4">
        <div>
          <label
            htmlFor="wallet-input"
            className="block font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mb-1.5"
          >
            Wallet address
          </label>
          <input
            id="wallet-input"
            type="text"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && analyze()}
            placeholder="0x..."
            spellCheck={false}
            className="w-full rounded-xl border border-ink/15 bg-paper px-3.5 py-2.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-ink/40 focus:outline-none transition-colors"
          />
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1">
            <span className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mr-1">Period</span>
            {[30, 90, 180].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`rounded-lg border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] transition-all ${
                  days === d ? "border-ink bg-ink text-paper" : "border-ink/15 bg-paper text-ink hover:border-ink/40"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={analyze}
            disabled={loading}
            className="ml-auto flex items-center gap-2 rounded-xl bg-ink px-5 py-2.5 text-sm font-semibold text-paper disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
            {loading ? "Analyzing..." : "Analyze wallet"}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-400/8 px-4 py-3 text-sm text-red-400">
          <AlertCircle size={14} className="shrink-0" />
          {error}
        </div>
      )}

      {result && <Results result={result} />}
    </div>
  );
}
