import type { ChainKpis, ChainTvlHistory } from "@/lib/chain-kpis";

/**
 * Per-chain KPI cards on /chains/[slug]. Visual sibling of the HL builder
 * dashboard strip, with a clean adaptive layout: a chain with 5 KPIs
 * shows 5 cards, a chain with only native price + mcap shows 2.
 *
 * Card design intentionally lean: fixed label-height row + value row,
 * no per-card source badge (the methodology footer carries the
 * attribution once instead of repeating it on every card, which fights
 * with value scanning).
 *
 * Optional sparkline of TVL over the last 30 days, rendered as a single
 * SVG path below the cards. Sourced directly from DefiLlama's
 * historicalChainTvl endpoint (50 KB single-shot), revalidate 15 min.
 * Hidden when the chain has no TVL series (Monero) or the fetch failed.
 */

type CardDef = {
  label: string;
  value: number | null;
  format: "usd" | "count";
  tip: string;
};

export function ChainKpiStrip({
  kpis,
  nativeSymbol,
  tvlHistory,
}: {
  kpis: ChainKpis;
  nativeSymbol?: string;
  tvlHistory?: ChainTvlHistory | null;
}) {
  const cards: CardDef[] = [
    {
      label: "TVL",
      value: kpis.tvl,
      format: "usd",
      tip: "Total Value Locked across every DeFi protocol on this chain (lending, DEX, staking, restaking, …). Source: DefiLlama. Refreshed every 15 min.",
    },
    {
      label: "DEX volume 24h",
      value: kpis.dexVolume24h,
      format: "usd",
      tip: "Aggregate 24h trading volume across every DefiLlama-tracked DEX on this chain. Refreshed every 15 min.",
    },
    {
      label: "Stablecoins",
      value: kpis.stablesMcap,
      format: "usd",
      tip: "USD-pegged stablecoin circulating market cap on this chain. Source: DefiLlama. Refreshed every 15 min.",
    },
    {
      label: nativeSymbol ? `${nativeSymbol} price` : "Native price",
      value: kpis.nativePrice,
      format: "usd",
      tip: `Spot price (USD) of the chain's native token${nativeSymbol ? ` (${nativeSymbol})` : ""}. Source: Mobula. Refreshed every 5 min.`,
    },
    {
      label: nativeSymbol ? `${nativeSymbol} market cap` : "Native market cap",
      value: kpis.nativeMcap,
      format: "usd",
      tip: `Circulating market cap (USD) of the chain's native token${nativeSymbol ? ` (${nativeSymbol})` : ""}. Source: Mobula. Refreshed every 5 min.`,
    },
  ];

  const visible = cards.filter((c) => c.value != null && Number.isFinite(c.value));
  if (visible.length === 0) return null;

  return (
    <section className="mb-8">
      <p
        className="label-mono text-[10px] text-ink-faint mb-3"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        Live KPIs
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {visible.map((c) => (
          <KpiCard key={c.label} card={c} />
        ))}
      </div>

      {tvlHistory && tvlHistory.points.length >= 7 && (
        <TvlSparkline history={tvlHistory} />
      )}

      <p className="mt-3 text-[11px] text-ink-faint italic">
        Sources: TVL, DEX volume and stablecoin market cap from DefiLlama
        (refresh 15 min). Native token price and market cap from Mobula
        (refresh 5 min). Aggregated third-party metrics, not measurements
        produced by OpenChainBench; OCB-measured benchmarks for this
        chain are listed below.
      </p>
    </section>
  );
}

function KpiCard({ card }: { card: CardDef }) {
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col"
      title={card.tip}
      style={{ minHeight: 96 }}
    >
      <p
        className="label-mono text-[10px] text-ink-faint uppercase tracking-wide leading-snug"
        style={{
          fontFamily: "var(--font-mono, monospace)",
          minHeight: 28,
        }}
      >
        {card.label}
      </p>
      <p className="mt-auto text-lg sm:text-xl font-semibold tabular-nums leading-tight">
        {card.format === "usd"
          ? fmtUSD(card.value!)
          : fmtCount(card.value!)}
      </p>
    </div>
  );
}

/**
 * Tiny SVG sparkline rendering a TVL series. Single line, no axes, no
 * tooltip — just enough to show direction at a glance. Period and
 * endpoints labeled in a thin caption row below so readers can frame
 * the number without hover.
 */
function TvlSparkline({ history }: { history: ChainTvlHistory }) {
  const W = 1100;
  const H = 90;
  const PAD_L = 0;
  const PAD_R = 0;
  const PAD_T = 8;
  const PAD_B = 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const vals = history.points.map((p) => p.tvl);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const span = Math.max(1, maxV - minV);
  const n = history.points.length;
  const xFor = (i: number) => PAD_L + (plotW * i) / Math.max(1, n - 1);
  const yFor = (v: number) =>
    PAD_T + plotH - ((v - minV) / span) * plotH;

  const path = history.points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(p.tvl).toFixed(1)}`,
    )
    .join(" ");
  const areaPath = `${path} L ${xFor(n - 1).toFixed(1)} ${(PAD_T + plotH).toFixed(1)} L ${xFor(0).toFixed(1)} ${(PAD_T + plotH).toFixed(1)} Z`;

  const first = history.points[0];
  const last = history.points[history.points.length - 1];
  const deltaPct = first.tvl > 0 ? ((last.tvl - first.tvl) / first.tvl) * 100 : 0;
  const deltaTone =
    deltaPct >= 0
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-red-600 dark:text-red-400";
  const lineColor = deltaPct >= 0 ? "#10b981" : "#ef4444";

  return (
    <div className="mt-3 rounded-lg border border-ink/10 bg-paper-soft/30 p-3 sm:p-4">
      <div className="flex items-baseline justify-between mb-2 text-[11px]">
        <span
          className="text-ink-faint uppercase tracking-wide"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          TVL · last {n} days
        </span>
        <span
          className={`font-semibold tabular-nums ${deltaTone}`}
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {deltaPct >= 0 ? "+" : ""}
          {deltaPct.toFixed(1)}%
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-[80px] sm:h-[90px] block"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="chain-tvl-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.22} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#chain-tvl-area)" />
        <path
          d={path}
          fill="none"
          stroke={lineColor}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div
        className="mt-1 flex items-baseline justify-between text-[10.5px] text-ink-faint tabular-nums"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        <span>{fmtShortDate(first.date)} · {fmtUSD(first.tvl)}</span>
        <span>{fmtShortDate(last.date)} · {fmtUSD(last.tvl)}</span>
      </div>
    </div>
  );
}

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000_000) return `$${(v / 1_000_000_000_000).toFixed(2)}T`;
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  if (abs >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toExponential(2)}`;
}

function fmtCount(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

function fmtShortDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${month} ${d.getUTCDate()}`;
}
