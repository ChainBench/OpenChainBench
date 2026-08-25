"use client";

import { useState } from "react";
import {
  ArrowRight, Loader2, AlertCircle, TrendingDown, TrendingUp,
  ChevronDown, ChevronUp,
} from "lucide-react";

type Fill = {
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

type Result = {
  wallet: string;
  days: number;
  generatedAt: number;
  hl: {
    fills: number;
    notionalUsd: number;
    feesUsd: number;
    fundingUsd: number;
    netCostUsd: number;
    avgFeeRateBps: number;
    topCoins: TopCoin[];
    recentFills: Fill[];
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

function usd(n: number, dec = 2) {
  if (Math.abs(n) >= 10000) return "$" + Math.round(n).toLocaleString("en-US");
  if (Math.abs(n) >= 100) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function pct(rate: number) {
  return (rate * 100).toFixed(3) + "%";
}

function bps(rate: number) {
  return (rate * 10000).toFixed(2) + " bps";
}

function fmtDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function Kpi({ label, value, sub, green, red }: {
  label: string; value: string; sub?: string; green?: boolean; red?: boolean;
}) {
  return (
    <div className="card-soft rounded-xl p-4">
      <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint">{label}</p>
      <p className={`mt-1 font-mono text-xl font-semibold ${green ? "text-emerald-500" : red ? "text-red-400" : "text-ink"}`}>
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>}
    </div>
  );
}

function HlSection({ hl, comparison, gainsFeeRates }: {
  hl: Result["hl"]; comparison: Result["comparison"]; gainsFeeRates: Record<string, number>;
}) {
  const [showAll, setShowAll] = useState(false);
  const fills = showAll ? hl.recentFills : hl.recentFills.slice(0, 10);
  const saved = comparison.hlSavedVsGains;
  const multiple = comparison.hlCheaperMultiple;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint">Hyperliquid</p>
          <p className="mt-0.5 text-sm text-ink-soft">
            {hl.fills} fills · {pct(hl.avgFeeRateBps / 10000)} avg fee rate
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="font-mono text-2xl font-semibold text-ink">{usd(hl.feesUsd)}</p>
          <p className="text-xs text-ink-faint">trade fees paid</p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi label="Notional volume" value={usd(hl.notionalUsd, 0)} />
        <Kpi label="Trade fees" value={usd(hl.feesUsd)} sub={bps(hl.avgFeeRateBps / 10000)} />
        <Kpi
          label="Funding"
          value={(hl.fundingUsd >= 0 ? "+" : "") + usd(hl.fundingUsd)}
          sub={hl.fundingUsd >= 0 ? "received" : "paid"}
          green={hl.fundingUsd > 0.01}
          red={hl.fundingUsd < -0.01}
        />
        <Kpi label="Net cost" value={usd(hl.netCostUsd)} sub="fees − funding" />
      </div>

      {saved > 0.5 && multiple && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/6 px-4 py-3">
          <TrendingDown size={18} className="text-emerald-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-emerald-500">
              HL saved {usd(saved)} vs Gains — {multiple.toFixed(2)}x cheaper
            </p>
            <p className="text-xs text-ink-faint mt-0.5">
              Same {usd(comparison.hlNotionalOnGains, 0)} notional at live Gains rates (
              {Object.entries(gainsFeeRates).map(([c, r]) => `${c}: ${pct(r)}`).join(", ")}
              ) = {usd(comparison.gainsEquivForHlNotional)}
            </p>
          </div>
        </div>
      )}

      {hl.recentFills.length > 0 && (
        <div>
          <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mb-2">
            All trades ({hl.recentFills.length})
          </p>
          <div className="rounded-xl border border-ink/8 overflow-x-auto">
            <table className="w-full text-sm min-w-[520px]">
              <thead>
                <tr className="border-b border-ink/8">
                  <th className="text-left px-3 py-2.5 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint">Date</th>
                  <th className="text-left px-3 py-2.5 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint">Market</th>
                  <th className="text-left px-3 py-2.5 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint">Direction</th>
                  <th className="text-right px-3 py-2.5 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint">Notional</th>
                  <th className="text-right px-3 py-2.5 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint">HL fee</th>
                  <th className="text-right px-3 py-2.5 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint">Gains equiv</th>
                  <th className="text-right px-3 py-2.5 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-faint">PnL</th>
                </tr>
              </thead>
              <tbody>
                {fills.map((f, i) => {
                  const gainsDelta = f.gainsPerSide !== null ? f.gainsPerSide - f.hlFee : null;
                  const isOpen = f.closedPnl === 0;
                  return (
                    <tr key={i} className="border-b border-ink/5 last:border-0 hover:bg-ink/2 transition-colors">
                      <td className="px-3 py-2 font-mono text-xs text-ink-faint whitespace-nowrap">
                        {fmtDate(f.time)}
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-mono font-semibold text-ink">{f.coin}</span>
                        <span className="ml-1.5 text-[10px] text-ink-faint">{f.isTaker ? "taker" : "maker"}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          f.dir.toLowerCase().includes("long")
                            ? "bg-emerald-500/10 text-emerald-500"
                            : "bg-red-400/10 text-red-400"
                        }`}>
                          {f.dir}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-right text-ink-soft">{usd(f.notional, 0)}</td>
                      <td className="px-3 py-2 font-mono text-right font-semibold text-ink">{usd(f.hlFee, 4)}</td>
                      <td className="px-3 py-2 font-mono text-right">
                        {f.gainsPerSide !== null ? (
                          <span className="text-ink-soft">
                            {usd(f.gainsPerSide, 4)}
                            {gainsDelta !== null && gainsDelta > 0.0005 && (
                              <span className="ml-1.5 text-[10px] text-emerald-500 font-medium">
                                −{usd(gainsDelta, 3)} saved
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-ink-faint text-[10px]">not on Gains</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-right">
                        {!isOpen ? (
                          <span className={f.closedPnl > 0 ? "text-emerald-500" : "text-red-400"}>
                            {f.closedPnl > 0 ? "+" : ""}{usd(f.closedPnl, 2)}
                          </span>
                        ) : (
                          <span className="text-ink-faint text-[10px]">open</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {hl.recentFills.length > 10 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-2 flex items-center gap-1.5 text-xs text-ink-soft hover:text-ink transition-colors"
            >
              {showAll ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {showAll ? "Show less" : `Show all ${hl.recentFills.length} trades`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function GainsSection({ gains, comparison }: { gains: Result["gains"]; comparison: Result["comparison"] }) {
  const delta = comparison.gainsSavedVsHl;
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint">Gains.trade (Arbitrum)</p>
          <p className="mt-0.5 text-sm text-ink-soft">
            {gains.events} USDC events · {pct(gains.avgFeeRateBps / 10000)} avg
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="font-mono text-2xl font-semibold text-ink">{usd(gains.feesUsdc)}</p>
          <p className="text-xs text-ink-faint">trade fees paid</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Kpi label="Position size (USDC)" value={usd(gains.positionSizeUsdc, 0)} />
        <Kpi label="Fees paid" value={usd(gains.feesUsdc)} sub={bps(gains.avgFeeRateBps / 10000)} />
      </div>

      {Math.abs(delta) > 0.5 && (
        <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${
          delta < 0 ? "border-red-400/20 bg-red-400/6" : "border-emerald-500/20 bg-emerald-500/6"
        }`}>
          {delta < 0
            ? <TrendingDown size={18} className="text-red-400 shrink-0 mt-0.5" />
            : <TrendingUp size={18} className="text-emerald-500 shrink-0 mt-0.5" />
          }
          <div>
            {delta < 0 ? (
              <p className="text-sm font-semibold text-red-400">
                HL would have saved {usd(Math.abs(delta))}
              </p>
            ) : (
              <p className="text-sm font-semibold text-emerald-500">
                Gains saved {usd(delta)} vs HL
              </p>
            )}
            <p className="text-xs text-ink-faint mt-0.5">
              HL standard taker ({pct(comparison.hlRoundTripRate)} round-trip) on{" "}
              {usd(gains.positionSizeUsdc, 0)} = {usd(comparison.hlEquivForGainsVolume)} vs{" "}
              {usd(gains.feesUsdc)} paid on Gains
            </p>
          </div>
        </div>
      )}

      <p className="text-xs text-ink-faint">
        Source: <code className="font-mono text-[11px]">FeesProcessed</code> events on{" "}
        <code className="font-mono text-[11px]">0xFF16…7f169</code> (Arbitrum). USDC collateral
        only. Open positions without a matching close are counted as single events.
      </p>
    </div>
  );
}

function Results({ result }: { result: Result }) {
  const hasHl = result.hl.fills > 0;
  const hasGains = result.gains.events > 0;

  if (!hasHl && !hasGains) {
    return (
      <div className="card-soft rounded-xl p-8 text-center">
        <p className="text-ink-soft">No trades found on either platform in the last {result.days} days.</p>
        <p className="mt-1 text-sm text-ink-faint">Try a longer period or verify the address.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {hasHl && (
        <div className="card-soft rounded-xl p-5">
          <HlSection hl={result.hl} comparison={result.comparison} gainsFeeRates={result.gainsFeeRates} />
        </div>
      )}
      {hasGains && (
        <div className="card-soft rounded-xl p-5">
          <GainsSection gains={result.gains} comparison={result.comparison} />
        </div>
      )}
      <p className="text-xs text-ink-faint px-1">
        HL fees: real data from Hyperliquid fills API. Gains fees: real on-chain FeesProcessed
        events. Cross-platform estimates use live Gains fee schedule and HL public taker rate.
        Funding excluded from cross-platform estimates.
      </p>
    </div>
  );
}

export function FeeCompareClient() {
  const [wallet, setWallet] = useState("");
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
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
        setError(res.status === 429 ? "Rate limited — wait a moment." : (d.error ?? "Something went wrong."));
        return;
      }
      setResult(await res.json());
    } catch {
      setError("Network error — check your connection.");
    } finally {
      setLoading(false);
    }
  }

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
            <span className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint mr-1">Period</span>
            {[30, 90, 180].map((d) => (
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
            {loading ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
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

      {result && <Results result={result} />}
    </div>
  );
}
