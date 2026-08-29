"use client";

import { useState, useEffect, useRef } from "react";
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
// Venue list
// ──────────────────────────────────────────────────────────────────────

const COMPARABLE_VENUES = [
  { slug: "hyperliquid", name: "Hyperliquid", chain: "Hyperliquid L1" },
  { slug: "gains",       name: "Gains",       chain: "Arbitrum / Base" },
  { slug: "dydx",        name: "dYdX v4",     chain: "Cosmos" },
  { slug: "gmx-v2",      name: "GMX v2",      chain: "Arbitrum" },
  { slug: "paradex",     name: "Paradex",     chain: "Starknet" },
  { slug: "edgex",       name: "EdgeX",       chain: "zkSync" },
] as const;

type VenueSlug = (typeof COMPARABLE_VENUES)[number]["slug"];

// Venues that accept an EVM 0x wallet address
const EVM_WALLET_VENUES: VenueSlug[] = ["hyperliquid", "gains", "gmx-v2"];

const VENUE_LOGOS: Partial<Record<VenueSlug, string>> = {
  hyperliquid: "/logos/hyperliquid.png",
  gains:       "/logos/gains.png",
  dydx:        "/logos/dydx.svg",
  "gmx-v2":    "/logos/gmx.svg",
  paradex:     "/logos/paradex.jpg",
  edgex:       "/logos/edgex.jpg",
};

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

type HlFillRow = {
  time: number;
  coin: string;
  dir: string;
  side: string;
  notional: number;
  hlFee: number;
  equivFee?: number;
  closedPnl: number;
  isTaker: boolean;
};

type HlTopCoin = {
  coin: string;
  fills: number;
  notional: number;
  fees: number;
};

type HlWalletData = {
  fills: number;
  notionalUsd: number;
  feesUsd: number;
  fundingUsd: number;
  netCostUsd: number;
  avgFeeRateBps: number;
  topCoins: HlTopCoin[];
  recentFills: HlFillRow[];
};

type GainsWalletData = {
  events: number;
  feesUsdc: number;
  vaultFeesUsdc: number;
  fundingFeesUsdc: number;
  fundingEstimated: boolean;
  borrowingFeesUsdc: number;
  netCostUsdc: number;
  positionSizeUsdc: number;
  avgFeeRateBps: number;
  recentTrades: Array<{
    date: string;
    pair: string;
    action: string;
    notional: number;
    tradingFee: number;
    vaultFee: number;
    fundingFee: number;
    borrowingFee: number;
    equivFee?: number;
    pnl_net: number;
  }>;
};

type GmxWalletData = {
  trades: number;
  feesUsdc: number;
  borrowingFeesUsdc: number;
  fundingFeesUsdc: number;
  netCostUsdc: number;
  notionalUsd: number;
  avgFeeRateBps: number;
  recentTrades: Array<{
    timestamp: number;
    sizeDeltaUsd: number;
    isLong: boolean;
    tradingFee: number;
    borrowingFee: number;
    fundingFee: number;
    pnlUsd: number;
  }>;
};

type DydxWalletData = {
  fills: number;
  feesUsdc: number;
  fundingUsd: number;
  netCostUsdc: number;
  notionalUsd: number;
  avgFeeRateBps: number;
};

type AnyWallet = HlWalletData | GainsWalletData | GmxWalletData | DydxWalletData;

type VenueResult = {
  slug: string;
  name: string;
  ratePerAction: number;
  rateBps: number;
  rateNote: string;
  rateIsLive: boolean;
  wallet: AnyWallet | null;
  effectiveRateBps?: number;
  effectiveRateNote?: string;
};

type SimResult = {
  notionalUsed: number;
  feesActual: number;
  equivFees: number;
  saved: number;
  multiple: number | null;
  fundingUsd?: number;
  projectedCarry?: {
    takerFees: number;
    borrowFees: number;
    fundingFees: number;
    borrowProjected: boolean;
    fundingProjected: boolean;
  };
};

type ComparisonResult = {
  aToBSim: SimResult | null;
  bToASim: SimResult | null;
};

type FeeCompareResult = {
  wallet: string | null;
  dydxAddress: string | null;
  days: number;
  generatedAt: number;
  venueA: VenueResult;
  venueB: VenueResult;
  comparison: ComparisonResult;
};

// ──────────────────────────────────────────────────────────────────────
// Wallet data helpers (slug-based instead of type guards)
// ──────────────────────────────────────────────────────────────────────

function walletFees(slug: string, w: AnyWallet): number {
  if (slug === "hyperliquid") return (w as HlWalletData).netCostUsd;
  if (slug === "gains") return (w as GainsWalletData).netCostUsdc;
  if (slug === "gmx-v2") return (w as GmxWalletData).netCostUsdc;
  if (slug === "dydx") return (w as DydxWalletData).netCostUsdc;
  return 0;
}

function walletVolume(slug: string, w: AnyWallet): number {
  if (slug === "hyperliquid") return (w as HlWalletData).notionalUsd;
  if (slug === "gains") return (w as GainsWalletData).positionSizeUsdc;
  return (w as GmxWalletData | DydxWalletData).notionalUsd;
}

function walletLabel(slug: string, w: AnyWallet): string {
  if (slug === "hyperliquid") return `${(w as HlWalletData).fills} fills`;
  if (slug === "gains") return `${(w as GainsWalletData).events} trades`;
  if (slug === "gmx-v2") return `${(w as GmxWalletData).trades} trades`;
  if (slug === "dydx") return `${(w as DydxWalletData).fills} fills`;
  return "";
}

function walletHasActivity(slug: string, w: AnyWallet): boolean {
  if (slug === "hyperliquid") return (w as HlWalletData).fills > 0;
  if (slug === "gains") return (w as GainsWalletData).events > 0;
  if (slug === "gmx-v2") return (w as GmxWalletData).trades > 0;
  if (slug === "dydx") return (w as DydxWalletData).fills > 0;
  return false;
}

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

function VenueLogo({ slug, size = 28 }: { slug: string; size?: number }) {
  const src = VENUE_LOGOS[slug as VenueSlug];
  if (!src) {
    return (
      <div
        style={{ width: size, height: size }}
        className="rounded-full bg-ink/15 flex items-center justify-center shrink-0"
      >
        <span className="text-[9px] font-bold text-ink-faint uppercase">
          {slug.slice(0, 2)}
        </span>
      </div>
    );
  }
  return (
    <Image
      src={src}
      alt={slug}
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
    <span
      className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${cls}`}
    >
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

function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-emerald-500">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      Live
    </span>
  );
}

function ProtocolBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ink/8 border border-ink/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.1em] text-ink-faint">
      Protocol
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────
// VenueDropdown
// ──────────────────────────────────────────────────────────────────────

function VenueDropdown({
  label,
  value,
  exclude,
  onChange,
}: {
  label: string;
  value: VenueSlug;
  exclude: VenueSlug;
  onChange: (v: VenueSlug) => void;
}) {
  const venue = COMPARABLE_VENUES.find((v) => v.slug === value)!;
  return (
    <div className="flex-1 min-w-0">
      <label className="block font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mb-1.5">
        {label}
      </label>
      <div className="relative">
        <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
          <VenueLogo slug={value} size={18} />
        </div>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as VenueSlug)}
          className="w-full appearance-none rounded-xl border border-ink/15 bg-paper pl-9 pr-8 py-2.5 text-sm font-semibold text-ink focus:border-ink/40 focus:outline-none transition-colors cursor-pointer"
        >
          {COMPARABLE_VENUES.filter((v) => v.slug !== exclude).map((v) => (
            <option key={v.slug} value={v.slug}>
              {v.name} — {v.chain}
            </option>
          ))}
        </select>
        <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint">
          <ChevronDown size={14} />
        </div>
      </div>
      <p className="mt-1 text-[10px] text-ink-faint font-mono">{venue.chain}</p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// RateCard
// ──────────────────────────────────────────────────────────────────────

function RateComparisonCard({
  venueA,
  venueB,
}: {
  venueA: VenueResult;
  venueB: VenueResult;
}) {
  const aBps = venueA.effectiveRateBps ?? venueA.rateBps;
  const bBps = venueB.effectiveRateBps ?? venueB.rateBps;
  const aRate = venueA.effectiveRateBps !== undefined ? venueA.effectiveRateBps / 10000 : venueA.ratePerAction;
  const bRate = venueB.effectiveRateBps !== undefined ? venueB.effectiveRateBps / 10000 : venueB.ratePerAction;
  const aWins = aRate < bRate;
  const bWins = bRate < aRate;
  const diff = Math.abs(aBps - bBps);
  const usingEffective = venueA.effectiveRateBps !== undefined || venueB.effectiveRateBps !== undefined;

  return (
    <div className="card-soft rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-ink/8">
        <p className="font-bold text-sm text-ink">Fee rates</p>
        <p className="text-xs text-ink-faint mt-0.5">
          {usingEffective ? "Effective rate based on your fills" : "Per-action taker rate comparison"}
        </p>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr]">
        <div className={`p-5 sm:p-6 ${aWins ? "bg-emerald-500/4" : ""}`}>
          <div className="flex items-center gap-2 mb-3">
            <VenueLogo slug={venueA.slug} size={20} />
            <p className="font-bold text-sm text-ink">{venueA.name}</p>
            {aWins && diff > 0.1 && <span className="ml-auto"><CheaperBadge /></span>}
          </div>
          <p
            className={`font-mono text-3xl font-extrabold leading-none tracking-tight ${
              aWins ? "text-emerald-500" : "text-ink"
            }`}
          >
            {fmt(aBps, 2)}
            <span className="text-lg font-semibold text-ink-faint ml-1">bps</span>
          </p>
          <div className="flex items-center gap-1.5 mt-2">
            {venueA.rateIsLive ? <LiveBadge /> : <ProtocolBadge />}
            <p className="text-[11px] text-ink-faint">{venueA.rateNote}</p>
          </div>
          {venueA.effectiveRateNote && (
            <p className="text-[10px] text-ink-faint/70 mt-0.5 italic">{venueA.effectiveRateNote}</p>
          )}
        </div>

        <div className="flex flex-col items-center justify-center px-3">
          <div className="w-px flex-1 bg-ink/10" />
          <div className="rounded-full border border-ink/15 bg-paper px-2.5 py-1 my-2">
            <span className="font-mono text-[11px] font-bold text-ink-faint">VS</span>
          </div>
          <div className="w-px flex-1 bg-ink/10" />
        </div>

        <div className={`p-5 sm:p-6 ${bWins ? "bg-emerald-500/4" : ""}`}>
          <div className="flex items-center gap-2 mb-3">
            <VenueLogo slug={venueB.slug} size={20} />
            <p className="font-bold text-sm text-ink">{venueB.name}</p>
            {bWins && diff > 0.1 && <span className="ml-auto"><CheaperBadge /></span>}
          </div>
          <p
            className={`font-mono text-3xl font-extrabold leading-none tracking-tight ${
              bWins ? "text-emerald-500" : "text-ink"
            }`}
          >
            {fmt(bBps, 2)}
            <span className="text-lg font-semibold text-ink-faint ml-1">bps</span>
          </p>
          <div className="flex items-center gap-1.5 mt-2">
            {venueB.rateIsLive ? <LiveBadge /> : <ProtocolBadge />}
            <p className="text-[11px] text-ink-faint">{venueB.rateNote}</p>
          </div>
          {venueB.effectiveRateNote && (
            <p className="text-[10px] text-ink-faint/70 mt-0.5 italic">{venueB.effectiveRateNote}</p>
          )}
        </div>
      </div>
      {diff > 0.01 ? (
        <div className="border-t border-ink/8 px-5 py-3">
          {aWins ? (
            <p className="text-xs text-ink-soft">
              <span className="font-semibold text-emerald-500">{venueA.name}</span> is{" "}
              <span className="font-mono font-bold">{fmt(diff, 2)} bps</span> cheaper
              {usingEffective ? " (for your coins)" : " per action"}
              {bBps > 0 && (
                <span className="text-ink-faint ml-1">
                  (
                  {fmt(
                    ((bRate - aRate) / bRate) * 100,
                    0
                  )}
                  % less)
                </span>
              )}
            </p>
          ) : (
            <p className="text-xs text-ink-soft">
              <span className="font-semibold text-emerald-500">{venueB.name}</span> is{" "}
              <span className="font-mono font-bold">{fmt(diff, 2)} bps</span> cheaper
              {usingEffective ? " (for your coins)" : " per action"}
              {aBps > 0 && (
                <span className="text-ink-faint ml-1">
                  (
                  {fmt(
                    ((aRate - bRate) / aRate) * 100,
                    0
                  )}
                  % less)
                </span>
              )}
            </p>
          )}
        </div>
      ) : (
        <div className="border-t border-ink/8 px-5 py-3">
          <p className="text-xs text-ink-faint">Rates are approximately equal</p>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// SimBox — shared comparison sub-card
// ──────────────────────────────────────────────────────────────────────

function SimBox({
  sim,
  otherName,
  thisName,
}: {
  sim: SimResult;
  otherName: string;
  thisName: string;
}) {
  return (
    <div className="bg-ink/4 rounded-xl p-3 space-y-1">
      <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        Same trades on {otherName}
      </p>
      <p
        className={`font-mono font-bold text-base ${
          sim.saved > 0.5
            ? "text-emerald-500"
            : sim.saved < -0.5
            ? "text-red-400"
            : "text-ink"
        }`}
      >
        {fmtUsd(sim.equivFees)}
      </p>
      {sim.saved > 0.5 && (
        <p className="text-[10px] text-emerald-500 font-semibold">
          {thisName} total advantage: {fmtUsd(sim.saved)}
          {sim.feesActual < -0.01
            ? ` (${fmtUsd(sim.equivFees)} equiv + ${fmtUsd(Math.abs(sim.feesActual))} earned)`
            : sim.multiple && sim.multiple > 1.05
            ? ` (${fmt(sim.multiple, 1)}x cheaper)`
            : ""}
        </p>
      )}
      {sim.saved < -0.5 && (
        <p className="text-[10px] text-red-400 font-semibold">
          {otherName} would save {fmtUsd(Math.abs(sim.saved))}
        </p>
      )}
      {Math.abs(sim.saved) <= 0.5 && (
        <p className="text-[10px] text-ink-faint">Roughly equal cost</p>
      )}
      {sim.fundingUsd !== undefined && Math.abs(sim.fundingUsd) > 0.5 && (
        <p className="text-[10px] text-ink-faint mt-1">
          {sim.fundingUsd > 0
            ? `+ ${fmtUsd(sim.fundingUsd)} funding received on ${thisName}`
            : `− ${fmtUsd(Math.abs(sim.fundingUsd))} funding paid on ${thisName}`}
        </p>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// WalletSummaryCard
// ──────────────────────────────────────────────────────────────────────

function WalletSide({
  venue,
  otherVenue,
  sim,
  crossSim,
}: {
  venue: VenueResult;
  otherVenue: VenueResult;
  sim: SimResult | null;
  crossSim?: SimResult | null;
}) {
  const w = venue.wallet;
  const hasActivity = w !== null && walletHasActivity(venue.slug, w);

  if (!hasActivity) {
    if (crossSim) {
      const carry = crossSim.projectedCarry;
      const takerFees = carry ? carry.takerFees : crossSim.equivFees;
      const hasCarry = carry && (carry.borrowFees > 0.01 || carry.fundingFees > 0.01);
      const netLabel = hasCarry
        ? "incl. est. carry"
        : carry
          ? (carry.borrowProjected || carry.fundingProjected ? "incl. est. carry" : "taker only")
          : "taker only";

      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2.5 mb-1">
            <VenueLogo slug={venue.slug} size={24} />
            <div>
              <p className="font-bold text-sm text-ink">{venue.name}</p>
              <p className="text-[11px] text-ink-faint mt-0.5">Projected from {otherVenue.name} history</p>
            </div>
          </div>

          <div>
            <p className="font-mono text-3xl font-extrabold tracking-tight leading-none text-ink">
              {fmtUsd(crossSim.equivFees)}
            </p>
            <p className="text-xs text-ink-faint mt-1.5">
              {hasCarry ? "est. all-in cost" : "taker fees only"}
            </p>
          </div>

          <div className="bg-ink/4 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Volume</p>
              <p className="font-mono text-xs font-semibold text-ink">{fmtUsd(crossSim.notionalUsed)}</p>
            </div>
            <div className="border-t border-ink/8 pt-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-ink-faint">Projected taker fees</p>
                <p className="font-mono text-xs font-semibold text-ink">{fmtUsd(takerFees)}</p>
              </div>
              {carry && carry.borrowFees > 0.01 && (
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-ink-faint">Est. borrowing fees</p>
                  <p className="font-mono text-xs font-semibold text-red-400">+{fmtUsd(carry.borrowFees)}</p>
                </div>
              )}
              {carry && carry.borrowProjected === false && carry.fundingFees < 0.01 && (
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-ink-faint">Borrowing fees</p>
                  <p className="text-[11px] text-ink-faint/50 italic">not applicable</p>
                </div>
              )}
              {carry && carry.fundingFees > 0.01 && (
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-ink-faint">Est. funding (projected)</p>
                  <p className="font-mono text-xs font-semibold text-red-400">+{fmtUsd(carry.fundingFees)}</p>
                </div>
              )}
              {carry && !carry.fundingProjected && carry.borrowFees > 0.01 && (
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-ink-faint">Funding</p>
                  <p className="text-[11px] text-ink-faint/50 italic">not projected</p>
                </div>
              )}
              {!carry && (
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-ink-faint">Carry (funding, borrow)</p>
                  <p className="text-[11px] text-ink-faint/50 italic">not projected</p>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-ink/8 pt-1.5">
                <p className="text-[11px] font-semibold text-ink-soft">
                  Net cost{" "}
                  <span className="font-normal text-[9px] text-ink-faint">{netLabel}</span>
                </p>
                <p className="font-mono text-xs font-bold text-ink">{fmtUsd(crossSim.equivFees)}</p>
              </div>
            </div>
          </div>

          {crossSim.saved > 0.5 && (
            <p className="text-[11px] text-red-400 font-semibold">
              {otherVenue.name} total advantage: {fmtUsd(crossSim.saved)}
              {crossSim.feesActual < -0.01 ? ` (incl. ${fmtUsd(Math.abs(crossSim.feesActual))} rebates earned)` : ""}
            </p>
          )}
          {crossSim.saved < -0.5 && (
            <p className="text-[11px] text-emerald-500 font-semibold">
              {venue.name} would save {fmtUsd(Math.abs(crossSim.saved))}
            </p>
          )}
        </div>
      );
    }
    return <p className="text-sm text-ink-faint">No {venue.name} activity</p>;
  }

  const fees = walletFees(venue.slug, w);
  const volume = walletVolume(venue.slug, w);
  const avgBps = w.avgFeeRateBps;
  const label = walletLabel(venue.slug, w);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5 mb-1">
        <VenueLogo slug={venue.slug} size={24} />
        <div>
          <p className="font-bold text-sm text-ink">{venue.name}</p>
          {label && <p className="text-[11px] text-ink-faint mt-0.5">{label}</p>}
        </div>
      </div>

      <div>
        {fees < -0.01 ? (
          <>
            <p className="font-mono text-3xl font-extrabold tracking-tight leading-none text-emerald-500">
              +{fmtUsd(Math.abs(fees))}
            </p>
            <p className="text-xs text-emerald-500/70 mt-1">maker rebates earned</p>
          </>
        ) : (
          <p className="font-mono text-3xl font-extrabold tracking-tight leading-none text-ink">
            {fmtUsd(fees)}
          </p>
        )}
        <p className="text-xs text-ink-faint mt-1.5">
          {venue.effectiveRateBps !== undefined
            ? `${fmt(venue.effectiveRateBps, 2)} bps net`
            : `${fmt(Math.abs(avgBps), 2)} bps avg`}
        </p>
      </div>

      {/* Venue-specific extra stats */}
      {venue.slug === "hyperliquid" && (() => {
        const hlW = w as HlWalletData;
        const hasFunding = Math.abs(hlW.fundingUsd) > 0.5;
        return (
          <div className="bg-ink/4 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Volume</p>
              <p className="font-mono text-xs font-semibold text-ink">{fmtUsd(volume)}</p>
            </div>
            <div className="border-t border-ink/8 pt-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-ink-faint">Trading fees</p>
                <p className="font-mono text-xs font-semibold text-ink">
                  {hlW.feesUsd < -0.01
                    ? <span className="text-emerald-500">+{fmtUsd(Math.abs(hlW.feesUsd))}</span>
                    : fmtUsd(hlW.feesUsd)}
                </p>
              </div>
              {hasFunding && (
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-ink-faint">
                    Funding {hlW.fundingUsd > 0 ? "received" : "paid"}
                  </p>
                  <p className={`font-mono text-xs font-semibold ${hlW.fundingUsd > 0 ? "text-emerald-500" : "text-red-400"}`}>
                    {hlW.fundingUsd > 0
                      ? `+${fmtUsd(hlW.fundingUsd)}`
                      : `−${fmtUsd(Math.abs(hlW.fundingUsd))}`}
                  </p>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-ink/8 pt-1.5">
                <p className="text-[11px] font-semibold text-ink-soft">Net cost</p>
                <p className={`font-mono text-xs font-bold ${hlW.netCostUsd < -0.01 ? "text-emerald-500" : "text-ink"}`}>
                  {hlW.netCostUsd < -0.01
                    ? `+${fmtUsd(Math.abs(hlW.netCostUsd))}`
                    : fmtUsd(hlW.netCostUsd)}
                </p>
              </div>
            </div>
          </div>
        );
      })()}
      {venue.slug === "gains" && (() => {
        const gW = w as GainsWalletData;
        const hasVault = (gW.vaultFeesUsdc ?? 0) > 0.5;
        const hasFunding = Math.abs(gW.fundingFeesUsdc) > 0.5;
        const hasBorrowing = gW.borrowingFeesUsdc > 0.5;
        return (
          <div className="bg-ink/4 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Total position value</p>
              <p className="font-mono text-xs font-semibold text-ink">{fmtUsd(volume)}</p>
            </div>
            <p className="text-[10px] text-ink-faint/60 leading-snug">
              Sum of (collateral × leverage) across all trades in the period.
            </p>
            <div className="border-t border-ink/8 pt-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-ink-faint">Taker fees</p>
                <p className="font-mono text-xs font-semibold text-ink">{fmtUsd(gW.feesUsdc)}</p>
              </div>
              {hasVault && (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-ink-faint">Vault fee</p>
                    <p className="font-mono text-xs font-semibold text-amber-500">
                      +{fmtUsd(gW.vaultFeesUsdc)}
                    </p>
                  </div>
                  <p className="text-[10px] text-ink-faint/60 leading-snug">
                    Gains charges an extra fee to LPs when your trade increases the long/short imbalance. Hyperliquid does not have this — it uses funding rates instead.
                  </p>
                </>
              )}
              {hasFunding && (
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-ink-faint">
                    Funding {gW.fundingFeesUsdc > 0 ? "paid" : "received"}
                    {gW.fundingEstimated && (
                      <span className="ml-1 text-[9px] text-ink-faint/50 italic">est.</span>
                    )}
                  </p>
                  <p className={`font-mono text-xs font-semibold ${gW.fundingFeesUsdc > 0 ? "text-red-400" : "text-emerald-500"}`}>
                    {gW.fundingFeesUsdc > 0
                      ? `−${fmtUsd(gW.fundingFeesUsdc)}`
                      : `+${fmtUsd(Math.abs(gW.fundingFeesUsdc))}`}
                  </p>
                </div>
              )}
              {hasBorrowing && (
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-ink-faint">Borrowing fees</p>
                  <p className="font-mono text-xs font-semibold text-red-400">
                    −{fmtUsd(gW.borrowingFeesUsdc)}
                  </p>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-ink/8 pt-1.5">
                <p className="text-[11px] font-semibold text-ink-soft">
                  Net cost all fees
                </p>
                <p className={`font-mono text-xs font-bold ${gW.netCostUsdc < -0.01 ? "text-emerald-500" : "text-ink"}`}>
                  {fmtUsd(gW.netCostUsdc)}
                </p>
              </div>
            </div>
          </div>
        );
      })()}
      {venue.slug === "gmx-v2" && (() => {
        const gW = w as GmxWalletData;
        const hasBorrowing = gW.borrowingFeesUsdc > 0.5;
        const hasFunding = Math.abs(gW.fundingFeesUsdc) > 0.5;
        return (
          <div className="bg-ink/4 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Volume</p>
              <p className="font-mono text-xs font-semibold text-ink">{fmtUsd(volume)}</p>
            </div>
            <div className="border-t border-ink/8 pt-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-ink-faint">Trading fees</p>
                <p className="font-mono text-xs font-semibold text-ink">{fmtUsd(gW.feesUsdc)}</p>
              </div>
              {hasBorrowing && (
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-ink-faint">Borrowing fees</p>
                  <p className="font-mono text-xs font-semibold text-red-400">−{fmtUsd(gW.borrowingFeesUsdc)}</p>
                </div>
              )}
              {hasFunding && (
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-ink-faint">Funding {gW.fundingFeesUsdc > 0 ? "paid" : "received"}</p>
                  <p className={`font-mono text-xs font-semibold ${gW.fundingFeesUsdc > 0 ? "text-red-400" : "text-emerald-500"}`}>
                    {gW.fundingFeesUsdc > 0 ? `−${fmtUsd(gW.fundingFeesUsdc)}` : `+${fmtUsd(Math.abs(gW.fundingFeesUsdc))}`}
                  </p>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-ink/8 pt-1.5">
                <p className="text-[11px] font-semibold text-ink-soft">
                  Net cost{" "}
                  <span className="font-normal text-[9px] text-ink-faint">
                    {hasBorrowing || hasFunding ? "incl. carry" : "trading only"}
                  </span>
                </p>
                <p className={`font-mono text-xs font-bold ${gW.netCostUsdc < -0.01 ? "text-emerald-500" : "text-ink"}`}>
                  {fmtUsd(gW.netCostUsdc)}
                </p>
              </div>
            </div>
          </div>
        );
      })()}

      {venue.slug === "dydx" && (() => {
        const dW = w as DydxWalletData;
        const hasFunding = Math.abs(dW.fundingUsd) > 0.5;
        return (
          <div className="bg-ink/4 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Volume</p>
              <p className="font-mono text-xs font-semibold text-ink">{fmtUsd(volume)}</p>
            </div>
            <div className="border-t border-ink/8 pt-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-ink-faint">Trading fees</p>
                <p className="font-mono text-xs font-semibold text-ink">{fmtUsd(dW.feesUsdc)}</p>
              </div>
              {hasFunding && (
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-ink-faint">Funding {dW.fundingUsd > 0 ? "received" : "paid"}</p>
                  <p className={`font-mono text-xs font-semibold ${dW.fundingUsd > 0 ? "text-emerald-500" : "text-red-400"}`}>
                    {dW.fundingUsd > 0 ? `+${fmtUsd(dW.fundingUsd)}` : `−${fmtUsd(Math.abs(dW.fundingUsd))}`}
                  </p>
                </div>
              )}
              {hasFunding && (
                <div className="flex items-center justify-between border-t border-ink/8 pt-1.5">
                  <p className="text-[11px] font-semibold text-ink-soft">Net cost</p>
                  <p className={`font-mono text-xs font-bold ${dW.netCostUsdc < -0.01 ? "text-emerald-500" : "text-ink"}`}>
                    {fmtUsd(dW.netCostUsdc)}
                  </p>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {venue.slug !== "hyperliquid" && venue.slug !== "gains" && venue.slug !== "gmx-v2" && venue.slug !== "dydx" && (
        <div className="bg-ink/4 rounded-xl p-3">
          <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Volume</p>
          <p className="font-mono font-semibold text-ink mt-1 text-sm">{fmtUsd(volume)}</p>
        </div>
      )}

      {sim && (
        <SimBox sim={sim} otherName={otherVenue.name} thisName={venue.name} />
      )}
    </div>
  );
}

function WalletSummaryCard({ result }: { result: FeeCompareResult }) {
  const { venueA, venueB, comparison } = result;

  const hasAData = venueA.wallet !== null && walletHasActivity(venueA.slug, venueA.wallet);
  const hasBData = venueB.wallet !== null && walletHasActivity(venueB.slug, venueB.wallet);

  if (!hasAData && !hasBData) {
    return (
      <div className="card-soft rounded-2xl p-8 text-center">
        <p className="text-ink-soft text-sm">
          No trades found in the last {result.days} days on either platform.
        </p>
      </div>
    );
  }

  return (
    <div className="card-soft rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-ink/8">
        <p className="font-bold text-sm text-ink">Wallet analysis</p>
        <p className="text-xs text-ink-faint mt-0.5">
          Net cost including carry (funding + borrowing) vs taker-rate projection on the other venue
        </p>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr]">
        <div className="p-5 sm:p-6">
          <WalletSide venue={venueA} otherVenue={venueB} sim={comparison.aToBSim} crossSim={comparison.bToASim} />
        </div>
        <div className="flex flex-col items-center justify-center px-3">
          <div className="w-px flex-1 bg-ink/10" />
          <div className="rounded-full border border-ink/15 bg-paper px-2.5 py-1 my-2">
            <span className="font-mono text-[11px] font-bold text-ink-faint">VS</span>
          </div>
          <div className="w-px flex-1 bg-ink/10" />
        </div>
        <div className="p-5 sm:p-6">
          <WalletSide venue={venueB} otherVenue={venueA} sim={comparison.bToASim} crossSim={comparison.aToBSim} />
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// HlTopCoinsCard
// ──────────────────────────────────────────────────────────────────────

function HlTopCoinsCard({
  topCoins,
  venueName,
}: {
  topCoins: HlTopCoin[];
  venueName: string;
}) {
  if (topCoins.length === 0) return null;
  return (
    <div className="card-soft rounded-2xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-ink/8">
        <VenueLogo slug="hyperliquid" size={20} />
        <p className="font-bold text-sm text-ink">{venueName} top markets</p>
      </div>
      <div className="divide-y divide-ink/5">
        {topCoins.map((c) => (
          <div
            key={c.coin}
            className="flex items-center gap-3 px-5 py-3 hover:bg-ink/2 transition-colors"
          >
            <span className="font-mono text-sm font-bold text-ink w-20 shrink-0 truncate">
              {c.coin}
            </span>
            <span className="text-xs text-ink-faint w-14 shrink-0">{c.fills} fills</span>
            <div className="flex-1 min-w-0">
              <div className="h-1 rounded-full bg-ink/8 overflow-hidden">
                <div
                  className="h-full rounded-full bg-ink/25"
                  style={{
                    width: `${Math.min(
                      100,
                      (c.notional / topCoins[0].notional) * 100
                    )}%`,
                  }}
                />
              </div>
            </div>
            <span className="font-mono text-xs text-ink-soft w-20 text-right shrink-0">
              {fmtUsd(c.notional)}
            </span>
            <span className="font-mono text-xs font-bold text-ink w-16 text-right shrink-0">
              {fmtUsd(c.fees)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// HlTradeTable
// ──────────────────────────────────────────────────────────────────────

function HlTradeTable({
  fills,
  venueName,
  venueSlug,
  otherVenueName,
}: {
  fills: HlFillRow[];
  venueName: string;
  venueSlug: string;
  otherVenueName?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const PREVIEW = 10;
  const rows = showAll ? fills : fills.slice(0, PREVIEW);
  const hasEquiv = !!otherVenueName && fills.some((f) => f.equivFee !== undefined);

  if (fills.length === 0) return null;

  return (
    <div className="card-soft rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-ink/8">
        <div className="flex items-center gap-2.5">
          <VenueLogo slug={venueSlug} size={20} />
          <p className="font-bold text-sm text-ink">
            {hasEquiv ? `${venueName} vs ${otherVenueName} — per trade` : `${venueName} trade history`}
          </p>
        </div>
        <p className="text-xs text-ink-faint">{fills.length} fills</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink/8 text-left bg-ink/2">
              <th className="px-5 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium">
                Date
              </th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium">
                Market
              </th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium hidden sm:table-cell">
                Direction
              </th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right hidden sm:table-cell">
                Notional
              </th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right">
                {venueName} fee
              </th>
              {hasEquiv && (
                <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right">
                  {otherVenueName} fee
                </th>
              )}
              {hasEquiv && (
                <th className="px-5 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right hidden sm:table-cell">
                  Diff
                </th>
              )}
              {!hasEquiv && (
                <th className="px-5 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right hidden md:table-cell">
                  PnL
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => {
              const isOpen = f.closedPnl === 0 && !f.dir.toLowerCase().includes("close");
              const diff = hasEquiv && f.equivFee !== undefined ? f.equivFee - f.hlFee : undefined;
              return (
                <tr
                  key={i}
                  className="border-b border-ink/5 last:border-0 hover:bg-ink/2 transition-colors"
                >
                  <td className="px-5 py-3 font-mono text-xs text-ink-faint whitespace-nowrap">
                    {fmtDate(f.time)}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs font-bold text-ink">{f.coin}</span>
                      {!f.isTaker && <MakerBadge />}
                    </div>
                  </td>
                  <td className="px-3 py-3 hidden sm:table-cell">
                    <DirBadge dir={f.dir} />
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-xs text-ink-soft hidden sm:table-cell">
                    {fmtUsd(f.notional)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-xs font-bold text-ink">
                    {fmtUsd(f.hlFee)}
                  </td>
                  {hasEquiv && f.equivFee !== undefined && (
                    <td className={`px-3 py-3 text-right font-mono text-xs font-bold ${
                      f.equivFee < f.hlFee ? "text-emerald-500" : f.equivFee > f.hlFee ? "text-red-400" : "text-ink-faint"
                    }`}>
                      {fmtUsd(f.equivFee)}
                    </td>
                  )}
                  {hasEquiv && diff !== undefined && (
                    <td className={`px-5 py-3 text-right font-mono text-xs font-semibold hidden sm:table-cell ${
                      diff > 0.001 ? "text-emerald-500" : diff < -0.001 ? "text-red-400" : "text-ink-faint"
                    }`}>
                      {diff > 0.001 ? `+${fmtUsd(diff)}` : diff < -0.001 ? fmtUsd(diff) : "—"}
                    </td>
                  )}
                  {!hasEquiv && (
                    <td className="px-5 py-3 text-right font-mono text-xs hidden md:table-cell">
                      {isOpen ? (
                        <span className="text-[10px] text-ink-faint/40">open</span>
                      ) : f.closedPnl > 0 ? (
                        <span className="text-emerald-500 font-semibold">
                          +{fmtUsd(f.closedPnl)}
                        </span>
                      ) : f.closedPnl < 0 ? (
                        <span className="text-red-400 font-semibold">
                          {fmtUsd(f.closedPnl)}
                        </span>
                      ) : (
                        <span className="text-ink-faint/30">$0</span>
                      )}
                    </td>
                  )}
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
          {showAll ? (
            <>
              <ChevronUp size={13} />Show less
            </>
          ) : (
            <>
              <ChevronDown size={13} />Show all {fills.length} trades
            </>
          )}
        </button>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// GainsTradeTable
// ──────────────────────────────────────────────────────────────────────

function GainsTradeTable({
  trades,
  venueName,
  otherVenueName,
}: {
  trades: GainsWalletData["recentTrades"];
  venueName: string;
  otherVenueName?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const PREVIEW = 10;
  const rows = showAll ? trades : trades.slice(0, PREVIEW);
  const hasEquiv = !!otherVenueName && trades.some((t) => t.equivFee !== undefined);

  if (trades.length === 0) return null;

  function actionLabel(action: string) {
    return action
      .replace("Trade", "")
      .replace("Market", "")
      .replace("Opened", "Open ")
      .replace("Closed", "Close ")
      .trim();
  }

  return (
    <div className="card-soft rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-ink/8">
        <div className="flex items-center gap-2.5">
          <VenueLogo slug="gains" size={20} />
          <p className="font-bold text-sm text-ink">
            {hasEquiv ? `${venueName} vs ${otherVenueName} — per trade` : `${venueName} trade history`}
          </p>
        </div>
        <p className="text-xs text-ink-faint">{trades.length} actions</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink/8 text-left bg-ink/2">
              <th className="px-5 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium">Date</th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium">Market</th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium hidden sm:table-cell">Action</th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right hidden sm:table-cell">Notional</th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right">{venueName} fee</th>
              {hasEquiv && (
                <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right">{otherVenueName} fee</th>
              )}
              <th className="px-5 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right hidden md:table-cell">PnL</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => {
              const hasVault = (t.vaultFee ?? 0) > 0.001;
              const netCost = t.tradingFee + (t.vaultFee ?? 0) + t.fundingFee + t.borrowingFee;
              const diff = hasEquiv && t.equivFee !== undefined ? t.equivFee - netCost : undefined;
              return (
              <tr key={i} className="border-b border-ink/5 last:border-0 hover:bg-ink/2 transition-colors">
                <td className="px-5 py-3 font-mono text-xs text-ink-faint whitespace-nowrap">
                  {new Date(t.date).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </td>
                <td className="px-3 py-3 font-mono text-xs font-bold text-ink">{t.pair.replace("/USD", "")}</td>
                <td className="px-3 py-3 hidden sm:table-cell">
                  <span className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${
                    t.action.includes("Opened") ? "bg-emerald-500/12 text-emerald-500"
                    : t.action.includes("Closed") ? "bg-ink/8 text-ink-faint"
                    : "bg-amber-400/10 text-amber-500"
                  }`}>
                    {actionLabel(t.action)}
                  </span>
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs text-ink-soft hidden sm:table-cell">{fmtUsd(t.notional)}</td>
                <td className="px-3 py-3 text-right">
                  <p className="font-mono text-xs font-bold text-ink">{fmtUsd(netCost)}</p>
                  <p className="text-[10px] text-ink-faint/70 mt-0.5 whitespace-nowrap">
                    {fmtUsd(t.tradingFee)} taker
                    {hasVault ? ` +${fmtUsd(t.vaultFee)} vault LP` : ""}
                    {t.borrowingFee > 0.001 ? ` +${fmtUsd(t.borrowingFee)} borrow` : ""}
                    {Math.abs(t.fundingFee) > 0.001
                      ? ` ${t.fundingFee > 0 ? "+" : "−"}${fmtUsd(Math.abs(t.fundingFee))} fund`
                      : ""}
                  </p>
                </td>
                {hasEquiv && (
                  <td className="px-3 py-3 text-right">
                    {t.equivFee !== undefined ? (
                      <>
                        <p className={`font-mono text-xs font-bold ${
                          t.equivFee < netCost ? "text-emerald-500" : t.equivFee > netCost ? "text-red-400" : "text-ink-faint"
                        }`}>{fmtUsd(t.equivFee)}</p>
                        {diff !== undefined && Math.abs(diff) > 0.01 && (
                          <p className={`text-[10px] mt-0.5 ${diff < 0 ? "text-emerald-500" : "text-red-400"}`}>
                            {diff < 0 ? `−${fmtUsd(Math.abs(diff))}` : `+${fmtUsd(diff)}`}
                          </p>
                        )}
                      </>
                    ) : (
                      <span className="text-[10px] text-ink-faint/40">n/a</span>
                    )}
                  </td>
                )}
                <td className="px-5 py-3 text-right font-mono text-xs hidden md:table-cell">
                  {t.action.includes("Closed") ? (
                    t.pnl_net > 0.01 ? (
                      <span className="text-emerald-500 font-semibold">+{fmtUsd(t.pnl_net)}</span>
                    ) : t.pnl_net < -0.01 ? (
                      <span className="text-red-400 font-semibold">{fmtUsd(t.pnl_net)}</span>
                    ) : (
                      <span className="text-ink-faint/30">$0</span>
                    )
                  ) : (
                    <span className="text-[10px] text-ink-faint/40">open</span>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {trades.length > PREVIEW && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="flex w-full items-center justify-center gap-1.5 border-t border-ink/8 py-3.5 text-xs text-ink-faint hover:text-ink transition-colors font-medium"
        >
          {showAll ? (
            <><ChevronUp size={13} />Show less</>
          ) : (
            <><ChevronDown size={13} />Show all {trades.length} actions</>
          )}
        </button>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// GmxTradeTable
// ──────────────────────────────────────────────────────────────────────

function GmxTradeTable({
  trades,
  venueName,
}: {
  trades: GmxWalletData["recentTrades"];
  venueName: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const PREVIEW = 10;
  const rows = showAll ? trades : trades.slice(0, PREVIEW);

  if (trades.length === 0) return null;

  return (
    <div className="card-soft rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-ink/8">
        <div className="flex items-center gap-2.5">
          <VenueLogo slug="gmx-v2" size={20} />
          <p className="font-bold text-sm text-ink">{venueName} trade history</p>
        </div>
        <p className="text-xs text-ink-faint">{trades.length} trades</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink/8 text-left bg-ink/2">
              <th className="px-5 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium">Date</th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium hidden sm:table-cell">Direction</th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right hidden sm:table-cell">Notional</th>
              <th className="px-3 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right">Net cost</th>
              <th className="px-5 py-3 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-right hidden md:table-cell">PnL</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => {
              const carry = t.borrowingFee + t.fundingFee;
              const netCost = t.tradingFee + carry;
              const hasCarry = t.borrowingFee > 0.001 || Math.abs(t.fundingFee) > 0.001;
              return (
              <tr key={i} className="border-b border-ink/5 last:border-0 hover:bg-ink/2 transition-colors">
                <td className="px-5 py-3 font-mono text-xs text-ink-faint whitespace-nowrap">
                  {new Date(t.timestamp * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </td>
                <td className="px-3 py-3 hidden sm:table-cell">
                  <span className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${t.isLong ? "bg-emerald-500/12 text-emerald-500" : "bg-red-400/12 text-red-400"}`}>
                    {t.isLong ? "Long" : "Short"}
                  </span>
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs text-ink-soft hidden sm:table-cell">{fmtUsd(t.sizeDeltaUsd)}</td>
                <td className="px-3 py-3 text-right">
                  <p className="font-mono text-xs font-bold text-ink">{fmtUsd(netCost)}</p>
                  {hasCarry && (
                    <p className="text-[10px] text-ink-faint/70 mt-0.5 whitespace-nowrap">
                      {fmtUsd(t.tradingFee)} fee
                      {t.borrowingFee > 0.001 ? ` +${fmtUsd(t.borrowingFee)} borrow` : ""}
                      {Math.abs(t.fundingFee) > 0.001
                        ? ` ${t.fundingFee > 0 ? "+" : "−"}${fmtUsd(Math.abs(t.fundingFee))} fund`
                        : ""}
                    </p>
                  )}
                </td>
                <td className="px-5 py-3 text-right font-mono text-xs hidden md:table-cell">
                  {t.pnlUsd > 0.01 ? (
                    <span className="text-emerald-500 font-semibold">+{fmtUsd(t.pnlUsd)}</span>
                  ) : t.pnlUsd < -0.01 ? (
                    <span className="text-red-400 font-semibold">{fmtUsd(t.pnlUsd)}</span>
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
      {trades.length > PREVIEW && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="flex w-full items-center justify-center gap-1.5 border-t border-ink/8 py-3.5 text-xs text-ink-faint hover:text-ink transition-colors font-medium"
        >
          {showAll ? <><ChevronUp size={13} />Show less</> : <><ChevronDown size={13} />Show all {trades.length} trades</>}
        </button>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Footnote
// ──────────────────────────────────────────────────────────────────────

function Footnote({ venueA, venueB }: { venueA: VenueResult; venueB: VenueResult }) {
  const hasHl = venueA.slug === "hyperliquid" || venueB.slug === "hyperliquid";
  const hasGains = venueA.slug === "gains" || venueB.slug === "gains";
  const hasGmx = venueA.slug === "gmx-v2" || venueB.slug === "gmx-v2";
  const hasDydx = venueA.slug === "dydx" || venueB.slug === "dydx";

  return (
    <p className="text-[11px] text-ink-faint px-1 leading-relaxed">
      {hasHl && (
        <>Hyperliquid: net cost includes taker fees and funding payments over the selected period. Fills via HL info endpoint. </>
      )}
      {hasGains && (
        <>
          Gains: net cost includes trading fees, funding, and borrowing over the period. History from{" "}
          <code className="font-mono text-[10px]">backend-global.gains.trade</code> REST API (Arbitrum).{" "}
        </>
      )}
      {hasGmx && (
        <>
          GMX v2: net cost includes trading fees, borrowing fees, and funding fees. Data via Subsquid indexer.{" "}
        </>
      )}
      {hasDydx && (
        <>
          dYdX v4: taker fills only. Funding not available from the public indexer. Address must be{" "}
          <code className="font-mono text-[10px]">dydx1...</code> Cosmos format.{" "}
        </>
      )}
      Paradex and EdgeX: taker rate comparison only, no wallet lookup.{" "}
      Simulated cost on the comparison venue uses the venue taker rate applied to your notional — carry costs (funding, borrowing) on the target venue are not projected as they depend on position duration and market conditions.
    </p>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Results
// ──────────────────────────────────────────────────────────────────────

function Results({ result }: { result: FeeCompareResult }) {
  const { venueA, venueB } = result;

  const hasWalletData =
    (venueA.wallet !== null && walletHasActivity(venueA.slug, venueA.wallet)) ||
    (venueB.wallet !== null && walletHasActivity(venueB.slug, venueB.wallet));

  const hlVenueA =
    venueA.slug === "hyperliquid" && venueA.wallet
      ? (venueA.wallet as HlWalletData)
      : null;
  const hlVenueB =
    venueB.slug === "hyperliquid" && venueB.wallet
      ? (venueB.wallet as HlWalletData)
      : null;
  const gainsVenueA = venueA.slug === "gains" && venueA.wallet ? (venueA.wallet as GainsWalletData) : null;
  const gainsVenueB = venueB.slug === "gains" && venueB.wallet ? (venueB.wallet as GainsWalletData) : null;
  const gmxVenueA = venueA.slug === "gmx-v2" && venueA.wallet ? (venueA.wallet as GmxWalletData) : null;
  const gmxVenueB = venueB.slug === "gmx-v2" && venueB.wallet ? (venueB.wallet as GmxWalletData) : null;

  return (
    <div className="space-y-4">
      <RateComparisonCard venueA={venueA} venueB={venueB} />
      {hasWalletData && <WalletSummaryCard result={result} />}
      {hlVenueA && hlVenueA.topCoins.length > 0 && (
        <HlTopCoinsCard topCoins={hlVenueA.topCoins} venueName={venueA.name} />
      )}
      {hlVenueA && hlVenueA.recentFills.length > 0 && (
        <HlTradeTable
          fills={hlVenueA.recentFills}
          venueName={venueA.name}
          venueSlug={venueA.slug}
          otherVenueName={venueB.name}
        />
      )}
      {hlVenueB && hlVenueB.topCoins.length > 0 && (
        <HlTopCoinsCard topCoins={hlVenueB.topCoins} venueName={venueB.name} />
      )}
      {hlVenueB && hlVenueB.recentFills.length > 0 && (
        <HlTradeTable
          fills={hlVenueB.recentFills}
          venueName={venueB.name}
          venueSlug={venueB.slug}
          otherVenueName={venueA.name}
        />
      )}
      {gainsVenueA && gainsVenueA.recentTrades.length > 0 && (
        <GainsTradeTable trades={gainsVenueA.recentTrades} venueName={venueA.name} otherVenueName={venueB.name} />
      )}
      {gainsVenueB && gainsVenueB.recentTrades.length > 0 && (
        <GainsTradeTable trades={gainsVenueB.recentTrades} venueName={venueB.name} otherVenueName={venueA.name} />
      )}
      {gmxVenueA && gmxVenueA.recentTrades.length > 0 && (
        <GmxTradeTable trades={gmxVenueA.recentTrades} venueName={venueA.name} />
      )}
      {gmxVenueB && gmxVenueB.recentTrades.length > 0 && (
        <GmxTradeTable trades={gmxVenueB.recentTrades} venueName={venueB.name} />
      )}
      <Footnote venueA={venueA} venueB={venueB} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// FeeCompareClient
// ──────────────────────────────────────────────────────────────────────

type InitialProps = {
  initialVenueA?: VenueSlug;
  initialVenueB?: VenueSlug;
  initialWallet?: string;
  initialDays?: number;
};

export function FeeCompareClient({
  initialVenueA = "hyperliquid",
  initialVenueB = "gains",
  initialWallet = "",
  initialDays = 90,
}: InitialProps = {}) {
  const [venueA, setVenueA] = useState<VenueSlug>(initialVenueA);
  const [venueB, setVenueB] = useState<VenueSlug>(initialVenueB);
  const [wallet, setWallet] = useState(initialWallet);
  const [dydxAddress, setDydxAddress] = useState("");
  const [days, setDays] = useState(initialDays);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FeeCompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const didAutoSubmit = useRef(false);

  useEffect(() => {
    if (!didAutoSubmit.current && initialWallet) {
      didAutoSubmit.current = true;
      analyze(initialVenueA, initialVenueB, initialWallet, initialDays);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needsEvmWallet =
    EVM_WALLET_VENUES.includes(venueA) || EVM_WALLET_VENUES.includes(venueB);
  const needsDydxAddr = venueA === "dydx" || venueB === "dydx";

  function handleVenueAChange(v: VenueSlug) {
    setVenueA(v);
    if (v === venueB) setVenueB(venueA);
    setResult(null);
  }

  function handleVenueBChange(v: VenueSlug) {
    setVenueB(v);
    if (v === venueA) setVenueA(venueB);
    setResult(null);
  }

  async function analyze(overrideVenueA?: VenueSlug, overrideVenueB?: VenueSlug, overrideWallet?: string, overrideDays?: number) {
    const va = overrideVenueA ?? venueA;
    const vb = overrideVenueB ?? venueB;
    const trimmed = (overrideWallet ?? wallet).trim();
    const dydxTrimmed = dydxAddress.trim();

    if ((EVM_WALLET_VENUES.includes(va) || EVM_WALLET_VENUES.includes(vb)) && trimmed && !/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      setError("Enter a valid Ethereum address (0x...)");
      return;
    }
    if ((va === "dydx" || vb === "dydx") && dydxTrimmed && !/^dydx1[a-z0-9]{38}$/.test(dydxTrimmed)) {
      setError("Enter a valid dYdX address (dydx1...)");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const params = new URLSearchParams({ venueA: va, venueB: vb, days: String(overrideDays ?? days) });
      if (trimmed) params.set("wallet", trimmed);
      if (dydxTrimmed) params.set("dydxAddress", dydxTrimmed);

      const res = await fetch(`/api/fee-compare?${params}`);
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          res.status === 429
            ? "Rate limited — wait a moment and try again."
            : d.error ?? "Something went wrong."
        );
        return;
      }
      const data = (await res.json()) as FeeCompareResult;
      setResult(data);
      if (trimmed) {
        const qs = new URLSearchParams({ venueA: va, venueB: vb, wallet: trimmed, days: String(overrideDays ?? days) });
        window.history.pushState({}, "", `/fee-compare?${qs}`);
      }
    } catch {
      setError("Network error — check your connection.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="card-soft rounded-2xl p-5 space-y-4">
        {/* Venue selectors */}
        <div className="flex items-end gap-3">
          <VenueDropdown
            label="Venue A"
            value={venueA}
            exclude={venueB}
            onChange={handleVenueAChange}
          />
          <div className="pb-6 shrink-0 text-ink-faint font-mono text-xs font-bold">VS</div>
          <VenueDropdown
            label="Venue B"
            value={venueB}
            exclude={venueA}
            onChange={handleVenueBChange}
          />
        </div>

        {/* EVM wallet — shown when HL, Gains, or GMX v2 selected */}
        <div>
          <label
            htmlFor="wallet-input"
            className="block font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mb-1.5"
          >
            Wallet address
            <span className="ml-2 normal-case font-normal text-ink-faint/60">
              {needsEvmWallet
                ? "optional — for per-trade analysis"
                : "select Hyperliquid, Gains, or GMX v2 to enable trade history"}
            </span>
          </label>
          <input
            id="wallet-input"
            type="text"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && analyze()}
            placeholder="0x..."
            spellCheck={false}
            disabled={!needsEvmWallet}
            className={`w-full rounded-xl border border-ink/15 bg-paper px-3.5 py-2.5 font-mono text-sm placeholder:text-ink-faint focus:border-ink/40 focus:outline-none transition-colors ${
              needsEvmWallet ? "text-ink" : "text-ink-faint/40 cursor-not-allowed"
            }`}
          />
        </div>

        {/* dYdX address — only shown when dYdX is one of the venues */}
        {needsDydxAddr && (
          <div>
            <label
              htmlFor="dydx-input"
              className="block font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mb-1.5"
            >
              dYdX address
              <span className="ml-2 normal-case font-normal text-ink-faint/60">
                optional — Cosmos format for trade history
              </span>
            </label>
            <input
              id="dydx-input"
              type="text"
              value={dydxAddress}
              onChange={(e) => setDydxAddress(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !loading && analyze()}
              placeholder="dydx1..."
              spellCheck={false}
              className="w-full rounded-xl border border-ink/15 bg-paper px-3.5 py-2.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-ink/40 focus:outline-none transition-colors"
            />
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1">
            <span className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mr-1">
              Period
            </span>
            {[30, 90, 180].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`rounded-lg border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] transition-all ${
                  days === d
                    ? "border-ink bg-ink text-paper"
                    : "border-ink/15 bg-paper text-ink hover:border-ink/40"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => analyze()}
            disabled={loading}
            className="ml-auto flex items-center gap-2 rounded-xl bg-ink px-5 py-2.5 text-sm font-semibold text-paper disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {loading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <ArrowRight size={14} />
            )}
            {loading ? "Analyzing..." : "Compare"}
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
