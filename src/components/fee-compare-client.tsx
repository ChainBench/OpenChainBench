"use client";

import { useState } from "react";
import { ArrowRight, Loader2, AlertCircle, TrendingDown, TrendingUp, Minus } from "lucide-react";

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

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtUsd(n: number) {
  if (Math.abs(n) >= 1000) return "$" + fmt(n, 0);
  return "$" + fmt(n, 2);
}

function StatBox({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="card-soft rounded-xl p-4">
      <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint">
        {label}
      </p>
      <p className="mt-1 font-mono text-xl font-semibold text-ink">{value}</p>
      {sub && (
        <p className="mt-0.5 font-sans text-xs text-ink-muted">{sub}</p>
      )}
    </div>
  );
}

function VerdictCard({ result }: { result: FeeCompareResult }) {
  const { hl, gains, comparison } = result;
  const hasHl = hl.fills > 0;
  const hasGains = gains.events > 0;

  if (!hasHl && !hasGains) {
    return (
      <div className="card-soft rounded-xl p-6 text-center">
        <p className="text-ink-soft">No trades found in the last {result.days} days on either platform.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {hasHl && (
        <div className="card-soft rounded-xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                Hyperliquid activity
              </p>
              <p className="mt-1 text-base text-ink-soft">
                {hl.fills} fills over {result.days} days
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="font-mono text-2xl font-semibold text-ink">
                {fmtUsd(hl.feesUsd)}
              </p>
              <p className="text-xs text-ink-faint">
                {fmt(hl.avgFeeRateBps, 3)} bps avg
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatBox
              label="Notional volume"
              value={fmtUsd(hl.notionalUsd)}
            />
            <StatBox
              label="Trade fees"
              value={fmtUsd(hl.feesUsd)}
              sub={fmt(hl.avgFeeRateBps, 3) + " bps"}
            />
            <StatBox
              label="Funding received"
              value={(hl.fundingUsd >= 0 ? "+" : "") + fmtUsd(hl.fundingUsd)}
              sub={hl.fundingUsd >= 0 ? "net gain" : "net paid"}
            />
          </div>

          {hl.topCoins.length > 0 && (
            <div>
              <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mb-2">
                Top markets
              </p>
              <div className="space-y-1">
                {hl.topCoins.map((c) => (
                  <div
                    key={c.coin}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="font-mono text-ink w-12 shrink-0">{c.coin}</span>
                    <span className="text-ink-faint text-xs">{c.fills} fills</span>
                    <span className="text-ink-soft font-mono flex-1 text-right">
                      {fmtUsd(c.notional)}
                    </span>
                    <span className="text-ink font-mono font-medium w-16 text-right">
                      {fmtUsd(c.fees)}
                    </span>
                    {c.gainsRoundTripRate !== null ? (
                      <span className="text-ink-faint text-[10px] w-24 text-right">
                        Gains {fmt(c.gainsRoundTripRate * 10000, 2)}bps
                      </span>
                    ) : (
                      <span className="text-ink-faint text-[10px] w-24 text-right">not on Gains</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-ink/8 pt-4">
            <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mb-2">
              If this trader had used Gains.trade instead
            </p>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <p className="text-sm text-ink-soft">
                  {fmtUsd(comparison.hlNotionalOnGains)} notional on Gains-listed coins
                  {" "}(live per-coin fee rates from Gains API)
                </p>
                <p className="font-mono text-lg text-ink font-semibold mt-0.5">
                  {fmtUsd(comparison.gainsEquivForHlNotional)} in fees
                </p>
              </div>
              <div className="shrink-0 text-right">
                {comparison.hlSavedVsGains > 1 ? (
                  <div className="flex items-center gap-1.5 text-emerald-500">
                    <TrendingDown size={16} />
                    <div>
                      <p className="font-mono font-semibold text-base">
                        {fmtUsd(comparison.hlSavedVsGains)} saved
                      </p>
                      {comparison.hlCheaperMultiple && (
                        <p className="text-xs">
                          HL {fmt(comparison.hlCheaperMultiple, 1)}x cheaper
                        </p>
                      )}
                    </div>
                  </div>
                ) : comparison.hlSavedVsGains < -1 ? (
                  <div className="flex items-center gap-1.5 text-red-400">
                    <TrendingUp size={16} />
                    <p className="font-mono font-semibold text-base">
                      {fmtUsd(Math.abs(comparison.hlSavedVsGains))} overpaid
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-ink-faint">
                    <Minus size={16} />
                    <p className="text-sm">Roughly equal</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {hasGains && (
        <div className="card-soft rounded-xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                Gains.trade activity (Arbitrum)
              </p>
              <p className="mt-1 text-base text-ink-soft">
                {gains.events} USDC trades over {result.days} days
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="font-mono text-2xl font-semibold text-ink">
                {fmtUsd(gains.feesUsdc)}
              </p>
              <p className="text-xs text-ink-faint">
                {fmt(gains.avgFeeRateBps, 3)} bps avg
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <StatBox
              label="Position size (USDC)"
              value={fmtUsd(gains.positionSizeUsdc)}
            />
            <StatBox
              label="Fees paid"
              value={fmtUsd(gains.feesUsdc)}
              sub={fmt(gains.avgFeeRateBps, 3) + " bps"}
            />
          </div>

          <div className="border-t border-ink/8 pt-4">
            <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mb-2">
              If this trader had used Hyperliquid instead
            </p>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <p className="text-sm text-ink-soft">
                  {fmtUsd(gains.positionSizeUsdc)} position size at HL standard taker{" "}
                  {fmt((comparison.hlRoundTripRate) * 10000, 2)}bps round-trip
                </p>
                <p className="font-mono text-lg text-ink font-semibold mt-0.5">
                  {fmtUsd(comparison.hlEquivForGainsVolume)} in fees
                </p>
              </div>
              <div className="shrink-0 text-right">
                {comparison.gainsSavedVsHl > 1 ? (
                  <div className="flex items-center gap-1.5 text-emerald-500">
                    <TrendingDown size={16} />
                    <p className="font-mono font-semibold text-base">
                      {fmtUsd(comparison.gainsSavedVsHl)} saved on Gains
                    </p>
                  </div>
                ) : comparison.gainsSavedVsHl < -1 ? (
                  <div className="flex items-center gap-1.5 text-red-400">
                    <TrendingUp size={16} />
                    <p className="font-mono font-semibold text-base">
                      HL would save {fmtUsd(Math.abs(comparison.gainsSavedVsHl))}
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-ink-faint">
                    <Minus size={16} />
                    <p className="text-sm">Roughly equal</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <p className="text-xs text-ink-faint px-1">
        HL fees: real data from Hyperliquid fills API. Gains fees: real{" "}
        <code className="font-mono">FeesProcessed</code> events from{" "}
        <code className="font-mono">0xFF16...7f169</code> on Arbitrum.
        Cross-platform estimates use live Gains fee schedule (fetched from
        backend-arbitrum.gains.trade) and the public HL standard taker rate
        (0.035% per side). Funding not included in cross-platform estimates.
      </p>
    </div>
  );
}

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
      const res = await fetch(
        `/api/fee-compare?wallet=${encodeURIComponent(trimmed)}&days=${days}`,
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        if (res.status === 429) {
          setError("Rate limited — wait a moment and try again.");
        } else {
          setError(d.error ?? "Something went wrong.");
        }
        return;
      }
      const data = await res.json();
      setResult(data);
    } catch {
      setError("Network error — check your connection.");
    } finally {
      setLoading(false);
    }
  }

  const DAY_OPTIONS = [30, 90, 180];

  return (
    <div className="space-y-6">
      <div className="card-soft rounded-xl p-5 space-y-4">
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
            className="w-full rounded-lg border border-ink/15 bg-paper px-3 py-2.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-ink/40 focus:outline-none transition-colors"
          />
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1">
            <span className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mr-1">
              Period
            </span>
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`rounded-md border px-2.5 py-1 text-[11px] font-sans font-medium uppercase tracking-[0.1em] transition-all ${
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
            onClick={analyze}
            disabled={loading}
            className="ml-auto flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {loading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <ArrowRight size={14} />
            )}
            {loading ? "Analyzing..." : "Analyze"}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-400/8 px-4 py-3 text-sm text-red-400">
          <AlertCircle size={14} className="shrink-0" />
          {error}
        </div>
      )}

      {result && <VerdictCard result={result} />}
    </div>
  );
}
