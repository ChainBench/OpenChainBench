import type { ChainKpis, ChainTvlHistory } from "@/lib/chain-kpis";
import { LiveNativeCard } from "@/components/live-native-card";
import { ChainTvlChart } from "@/components/chain-tvl-chart";

/**
 * Per-chain KPI cards on /chains/[slug].
 *
 * Layout:
 *   • Top row: 3-5 cards adaptive (TVL, DEX vol 24h, Stables from
 *     DefiLlama; native price + native mcap from Mobula. Mobula cards
 *     are live-polled every 2 s — see <LiveNativeCard>).
 *   • Below: interactive TVL chart with 7D/30D/90D/1Y/All range
 *     toggle and hover crosshair (see <ChainTvlChart>).
 *
 * Single footer attribution covers both sources, so the cards stay
 * uncluttered.
 */

type CardDef = {
  label: string;
  value: number | null;
  tip: string;
};

export function ChainKpiStrip({
  slug,
  kpis,
  nativeSymbol,
  tvlHistory,
  chainLabel,
}: {
  slug: string;
  kpis: ChainKpis;
  nativeSymbol?: string;
  tvlHistory?: ChainTvlHistory | null;
  chainLabel: string;
}) {
  const staticCards: CardDef[] = [
    {
      label: "TVL",
      value: kpis.tvl,
      tip: "Total Value Locked across every DeFi protocol on this chain (lending, DEX, staking, restaking, …). Source: DefiLlama. Refreshed every 15 min.",
    },
    {
      label: "DEX volume 24h",
      value: kpis.dexVolume24h,
      tip: "Aggregate 24h trading volume across every DefiLlama-tracked DEX on this chain. Refreshed every 15 min.",
    },
    {
      label: "Stablecoins",
      value: kpis.stablesMcap,
      tip: "USD-pegged stablecoin circulating market cap on this chain. Source: DefiLlama. Refreshed every 15 min.",
    },
  ];

  const visibleStatic = staticCards.filter(
    (c) => c.value != null && Number.isFinite(c.value),
  );
  const hasNative =
    nativeSymbol &&
    (kpis.nativePrice != null || kpis.nativeMcap != null);
  const visibleCount = visibleStatic.length + (hasNative ? 2 : 0);

  if (visibleCount === 0 && !tvlHistory) return null;

  return (
    <section className="mb-8">
      <p
        className="label-mono text-[10px] text-ink-faint mb-3"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        Live KPIs
      </p>
      {visibleCount > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {visibleStatic.map((c) => (
            <KpiCard key={c.label} card={c} />
          ))}
          {hasNative && nativeSymbol && (
            <>
              <LiveNativeCard
                slug={slug}
                symbol={nativeSymbol}
                kind="price"
                initialValue={kpis.nativePrice}
                tip={`Spot price (USD) of the chain's native token (${nativeSymbol}). Source: Mobula. Live refresh every 2 s.`}
              />
              <LiveNativeCard
                slug={slug}
                symbol={nativeSymbol}
                kind="mcap"
                initialValue={kpis.nativeMcap}
                tip={`Circulating market cap (USD) of the chain's native token (${nativeSymbol}). Source: Mobula. Live refresh every 2 s.`}
              />
            </>
          )}
        </div>
      )}

      {tvlHistory && tvlHistory.points.length >= 7 && (
        <ChainTvlChart history={tvlHistory} chainLabel={chainLabel} />
      )}

      <p className="mt-3 text-[11px] text-ink-faint italic">
        Sources: TVL, DEX volume and stablecoin market cap from DefiLlama
        (refresh 15 min). Native token price and market cap from Mobula
        (live refresh every 2 s). Aggregated third-party metrics, not
        measurements produced by OpenChainBench; OCB-measured benchmarks
        for this chain are listed below.
      </p>
    </section>
  );
}

function KpiCard({ card }: { card: CardDef }) {
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col"
      title={card.tip}
      // Height matches the live cards (label + value + sparkline slot)
      // so the strip stays aligned once the sparkline appears on the
      // Mobula cards after a few ticks. Cards without a sparkline keep
      // the bottom slot empty.
      style={{ minHeight: 132 }}
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
        {fmtUSD(card.value!)}
      </p>
      {/* Empty slot mirrors the live-card sparkline space so static and
          live KpiCards share the exact same baseline geometry. */}
      <div className="mt-1.5 h-[24px]" aria-hidden />
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
  return `$${v.toFixed(0)}`;
}
