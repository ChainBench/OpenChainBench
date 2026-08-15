import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { fetchEVMRevenue } from "@/lib/evm-exec";
import { fetchExecLeaderboard } from "@/lib/solana-exec";
import { fetchSolPrice } from "@/lib/sol-price";
import { fetchFOMORelayFees } from "@/lib/dune";
import { TRADING_APPS } from "@/lib/trading-apps-config";
import { fetchDeFiLlamaData } from "@/lib/defillama";
import { TradingAppsLeaderboard, type UnifiedAppRow } from "@/components/trading-apps-leaderboard";
import { RevenueSummary } from "@/components/revenue-summary";
import { SolanaExecTable } from "@/components/solana-exec-table";
import Link from "next/link";

const DESCRIPTION =
  "Protocol fees collected by trading apps and meme trading terminals — Solana, Ethereum, BSC. On-chain data, updated every 5 min.";

export const metadata: Metadata = pageMetadata({
  path: "/apps",
  title: "Trading App Revenue — pump.fun, Axiom, GMGN, BullX | OpenChainBench",
  description: DESCRIPTION,
});

export const revalidate = 300;

const WINDOWS = ["24h", "7d", "30d"] as const;

export default async function AppsHubPage() {
  const dlSlugMap = Object.fromEntries(
    TRADING_APPS.filter((a) => a.defillamaSlug).map((a) => [a.id, a.defillamaSlug!])
  );

  const [evmData, solanaData, solPrice, fomoRelay, dlData] = await Promise.all([
    fetchEVMRevenue(),
    fetchExecLeaderboard(),
    fetchSolPrice(),
    fetchFOMORelayFees(),
    fetchDeFiLlamaData(dlSlugMap),
  ]);

  const activeDlTotal = TRADING_APPS.filter((a) => !a.inactive && a.defillamaSlug)
    .reduce((sum, a) => sum + (dlData.get(a.id)?.total24h ?? 0), 0);

  const evmByPlatform = new Map(
    (evmData?.platforms ?? []).map((p) => [p.platform, p])
  );

  const solanaByPlatform = new Map(
    (solanaData?.platforms ?? []).map((p) => [p.platform, p])
  );

  const rows: UnifiedAppRow[] = TRADING_APPS.map((meta) => {
    const evmRow = meta.evmKey ? evmByPlatform.get(meta.evmKey) : undefined;
    const solRow = meta.solanaKey ? solanaByPlatform.get(meta.solanaKey) : undefined;

    const rhRow = meta.robinhoodKey ? evmByPlatform.get(meta.robinhoodKey) : undefined;

    const ethChain = evmRow?.chains["ethereum"];
    const bscChain = evmRow?.chains["bsc"];
    const baseChain = evmRow?.chains["base"];
    const rhChain = rhRow?.chains["robinhood"];

    const windows: UnifiedAppRow["windows"] = {};

    for (const w of WINDOWS) {
      let solanaFees: number | null = null;
      if (solRow) {
        const wData = solRow.windows[w];
        if (wData) {
          if (meta.solanaFeeIsUSDC) {
            solanaFees = wData.sumPlatformFeeLamports / 1e6;
          } else if (solPrice !== null) {
            solanaFees = wData.sumPlatformFeeLamports / 1e9 * solPrice;
          }
        }
      }

      if (meta.id === "fomo" && fomoRelay) {
        const relayFee = w === "24h" ? fomoRelay.fees24h : w === "7d" ? fomoRelay.fees7d : fomoRelay.fees30d;
        solanaFees = (solanaFees ?? 0) + relayFee;
      }

      const evmStable = (chain: typeof ethChain) =>
        !chain ? null : w === "24h" ? chain.stable24h : w === "7d" ? chain.stable7d : chain.stable30d;
      const evmNative = (chain: typeof ethChain) =>
        w === "24h" && chain ? (chain.native?.usd ?? 0) : 0;

      const ethFees = ethChain ? evmStable(ethChain)! + evmNative(ethChain) : null;
      const bscFees = bscChain ? evmStable(bscChain)! + evmNative(bscChain) : null;
      const baseFees = baseChain ? evmStable(baseChain)! + evmNative(baseChain) : null;
      const rhFees = rhChain ? evmStable(rhChain)! + evmNative(rhChain) : null;
      const evmTotal = (ethFees ?? 0) + (bscFees ?? 0) + (baseFees ?? 0) + (rhFees ?? 0);

      windows[w] = {
        solana: solanaFees,
        ethereum: ethFees,
        bsc: bscFees,
        base: baseFees,
        robinhood: rhFees,
        total: (solanaFees ?? 0) + evmTotal,
      };
    }

    const dl = dlData.get(meta.id) ?? null;
    const marketSharePct = dl && activeDlTotal > 0 && !meta.inactive
      ? (dl.total24h / activeDlTotal) * 100
      : null;

    return {
      meta,
      windows,
      stableOnly: {
        ethereum: ethChain?.coverage === "stable-only",
        bsc: bscChain?.coverage === "stable-only",
        base: baseChain?.coverage === "stable-only",
        robinhood: rhChain?.coverage === "stable-only",
      },
      dl,
      marketSharePct,
    };
  });

  const updatedAt = evmData?.updatedAt ?? solanaData?.updatedAt ?? null;

  const breadcrumb = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Apps", item: `${SITE.url}/apps` },
    ]),
  };

  return (
    <article className="mx-auto max-w-[900px] px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />

      <h1 className="display text-3xl sm:text-4xl text-ink leading-[1.05]">
        Trading app revenue.
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        {DESCRIPTION}
      </p>

      <div className="mt-10">
        <TradingAppsLeaderboard rows={rows} updatedAt={updatedAt} fomoLatestDate={fomoRelay?.latestDate ?? null} fomoRelayAvailable={fomoRelay !== null} activeDlTotal={activeDlTotal} />
      </div>

      <p className="mt-6 text-xs text-ink-muted leading-relaxed max-w-2xl">
        Solana fees = <span className="font-mono">sum(platform_fee) / 1e9 × SOL price</span>.
        EVM fees = stable (USDC/USDT) + native where traceable, always 24h.
      </p>

      {evmData && evmData.platforms.length > 0 && (
        <div className="mt-10 border-t border-rule pt-8">
          <RevenueSummary evm={evmData} />
        </div>
      )}

      <div className="mt-10 border-t border-rule pt-8">
        <h2 className="text-lg font-semibold text-ink mb-1">Solana execution quality</h2>
        <p className="text-sm text-ink-soft mb-6">
          Priority fees, Jito bundle rates, and platform fees per transaction — measured passively from on-chain data.
        </p>
        <SolanaExecTable
          platforms={solanaData?.platforms ?? []}
          updatedAt={solanaData?.updatedAt ?? null}
        />
        <div className="mt-4 text-xs text-ink-muted leading-relaxed max-w-2xl space-y-1.5">
          <p>
            <strong>Priority fee</strong> = total tx fee minus the 5 000-lamport base fee per signature.
          </p>
          <p>
            <strong>CU price</strong> = priority fee ÷ compute units consumed (microlamports/CU). p50/p95 shows median and tail pressure.
          </p>
          <p>
            <strong>Jito rate</strong> = fraction of transactions tipping a Jito tip account. Higher = more MEV-sensitive routing.
          </p>
          <p>
            <strong>Platform fee</strong> = avg SOL to the platform fee account per transaction.
            Source: Helius enhanced transaction API. No synthetic trades, no on-chain footprint.
          </p>
        </div>
      </div>

      <div className="mt-10 border-t border-rule pt-8">
        <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-3">Related benchmarks</p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/benchmarks/app-store-ratings"
            className="flex items-center gap-2.5 px-4 py-3 rounded-lg border border-rule bg-paper hover:bg-paper-soft transition-colors group"
          >
            <span className="text-lg">⭐</span>
            <div>
              <p className="text-sm font-medium text-ink group-hover:text-accent transition-colors">App Store Ratings</p>
              <p className="text-xs text-ink-muted">iOS ratings for crypto trading apps, live</p>
            </div>
            <svg className="ml-auto text-ink-faint group-hover:text-ink-muted transition-colors" width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3.5 3H2a1 1 0 00-1 1v6a1 1 0 001 1h6a1 1 0 001-1V8.5M7 1h4m0 0v4m0-4L5.5 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
          <Link
            href="/benchmarks/trading-app-execution"
            className="flex items-center gap-2.5 px-4 py-3 rounded-lg border border-rule bg-paper hover:bg-paper-soft transition-colors group"
          >
            <span className="text-lg">⚡</span>
            <div>
              <p className="text-sm font-medium text-ink group-hover:text-accent transition-colors">Execution Quality Bench</p>
              <p className="text-xs text-ink-muted">Priority fees, Jito rates, platform fees — full dataset</p>
            </div>
            <svg className="ml-auto text-ink-faint group-hover:text-ink-muted transition-colors" width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3.5 3H2a1 1 0 00-1 1v6a1 1 0 001 1h6a1 1 0 001-1V8.5M7 1h4m0 0v4m0-4L5.5 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
        </div>
      </div>
    </article>
  );
}
