import type { ChainKpis } from "@/lib/chain-kpis";

/**
 * Per-chain KPI cards on /chains/[slug]. Visual sibling of the HL
 * builder dashboard strip, with a clean adaptive layout: a chain with 6
 * KPIs gets 6 cards, a chain with only native price + mcap gets 2.
 * Server-rendered; no client interactivity needed for the strip itself.
 *
 * Each card carries a small "via <source>" badge so the reader can tell
 * which KPI is OCB-measured (none here yet — see benches below the strip)
 * versus aggregated by a third party (DefiLlama, Mobula). Hover surfaces
 * the methodology tooltip on the card.
 */

const SOURCE_BADGE = {
  defillama: { label: "DefiLlama", color: "#5468ff" },
  mobula: { label: "Mobula", color: "#10b981" },
} as const;

type CardDef = {
  label: string;
  value: number | null;
  format: "usd" | "count";
  source: keyof typeof SOURCE_BADGE;
  tip: string;
  nativeSymbol?: string;
};

export function ChainKpiStrip({
  kpis,
  nativeSymbol,
}: {
  kpis: ChainKpis;
  nativeSymbol?: string;
}) {
  const cards: CardDef[] = [
    {
      label: "TVL",
      value: kpis.tvl,
      format: "usd",
      source: "defillama",
      tip: "Total Value Locked across every DeFi protocol on this chain (lending, DEX, staking, restaking, …). Source: DefiLlama. Refreshed every 15 min.",
    },
    {
      label: "DEX volume 24h",
      value: kpis.dexVolume24h,
      format: "usd",
      source: "defillama",
      tip: "Aggregate 24h trading volume across every DefiLlama-tracked DEX on this chain. Refreshed every 15 min.",
    },
    {
      label: "Stablecoins",
      value: kpis.stablesMcap,
      format: "usd",
      source: "defillama",
      tip: "USD-pegged stablecoin circulating market cap on this chain. Source: DefiLlama. Refreshed every 15 min.",
    },
    {
      label: nativeSymbol ? `${nativeSymbol} price` : "Native price",
      value: kpis.nativePrice,
      format: "usd",
      source: "mobula",
      tip: `Spot price (USD) of the chain's native token${nativeSymbol ? ` (${nativeSymbol})` : ""}. Source: Mobula market data. Refreshed every 5 min.`,
      nativeSymbol,
    },
    {
      label: nativeSymbol ? `${nativeSymbol} market cap` : "Native market cap",
      value: kpis.nativeMcap,
      format: "usd",
      source: "mobula",
      tip: `Circulating market cap (USD) of the chain's native token${nativeSymbol ? ` (${nativeSymbol})` : ""}. Source: Mobula. Refreshed every 5 min.`,
      nativeSymbol,
    },
    {
      label: "Indexed by Mobula",
      value: kpis.mobulaTokensIndexed,
      format: "count",
      source: "mobula",
      tip: "Number of tokens Mobula's onchain indexer tracks on this chain. A proxy for how covered the chain is on the OCB infrastructure. Source: Mobula /market/blockchain/stats. Refreshed every 5 min.",
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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {visible.map((c) => (
          <KpiCard key={c.label} card={c} />
        ))}
      </div>
      <p className="mt-3 text-[11px] text-ink-faint italic">
        Methodology: TVL, DEX volume and stables sourced from DefiLlama
        (refresh 15 min); native token price, market cap and indexed
        tokens count sourced from Mobula (refresh 5 min). Each KPI is
        an aggregated third-party metric, not a measurement produced by
        OpenChainBench. OCB-measured benchmarks for this chain are listed
        below.
      </p>
    </section>
  );
}

function KpiCard({ card }: { card: CardDef }) {
  const badge = SOURCE_BADGE[card.source];
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 relative"
      title={card.tip}
    >
      <p
        className="label-mono text-[10px] text-ink-faint mb-1 uppercase tracking-wide"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {card.label}
      </p>
      <p className="text-lg sm:text-xl font-semibold tabular-nums leading-tight break-words">
        {card.format === "usd"
          ? fmtUSD(card.value!)
          : fmtCount(card.value!)}
      </p>
      <p
        className="mt-1 text-[9.5px] tracking-wide inline-flex items-center gap-1"
        style={{ fontFamily: "var(--font-mono, monospace)", color: badge.color }}
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: badge.color }}
          aria-hidden
        />
        via {badge.label}
      </p>
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
