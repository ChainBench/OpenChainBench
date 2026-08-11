import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { fetchEVMRevenue } from "@/lib/evm-exec";
import { fetchExecLeaderboard } from "@/lib/solana-exec";
import { fetchSolPrice } from "@/lib/sol-price";
import { TRADING_APPS } from "@/lib/trading-apps-config";
import { TradingAppsLeaderboard, type UnifiedAppRow } from "@/components/trading-apps-leaderboard";
import { RevenueSummary } from "@/components/revenue-summary";
import { ExecChainTabs } from "@/components/exec-chain-tabs";
import Link from "next/link";

const DESCRIPTION =
  "Protocol fees collected by trading apps: meme bots and telegram bots. On-chain data, updated hourly.";

export const metadata: Metadata = pageMetadata({
  path: "/apps",
  title: "Trading App Revenue — pump.fun, Axiom, GMGN, BullX | OpenChainBench",
  description: DESCRIPTION,
});

export const revalidate = 300;

const WINDOWS = ["24h", "7d", "30d"] as const;

export default async function AppsHubPage() {
  const [evmData, solanaData, solPrice] = await Promise.all([
    fetchEVMRevenue(),
    fetchExecLeaderboard(),
    fetchSolPrice(),
  ]);

  const evmByPlatform = new Map(
    (evmData?.platforms ?? []).map((p) => [p.platform, p])
  );

  const solanaByPlatform = new Map(
    (solanaData?.platforms ?? []).map((p) => [p.platform, p])
  );

  const rows: UnifiedAppRow[] = TRADING_APPS.map((meta) => {
    const evmRow = meta.evmKey ? evmByPlatform.get(meta.evmKey) : undefined;
    const solRow = meta.solanaKey ? solanaByPlatform.get(meta.solanaKey) : undefined;

    const ethChain = evmRow?.chains["ethereum"];
    const bscChain = evmRow?.chains["bsc"];
    const baseChain = evmRow?.chains["base"];

    // EVM fees are always 24h — we don't have multi-window EVM data.
    const ethFees = ethChain ? ethChain.stable24h + (ethChain.native?.usd ?? 0) : null;
    const bscFees = bscChain ? bscChain.stable24h + (bscChain.native?.usd ?? 0) : null;
    const baseFees = baseChain ? baseChain.stable24h + (baseChain.native?.usd ?? 0) : null;
    const evmTotal = (ethFees ?? 0) + (bscFees ?? 0) + (baseFees ?? 0);

    const windows: UnifiedAppRow["windows"] = {};

    for (const w of WINDOWS) {
      let solanaFees: number | null = null;
      if (solRow && solPrice !== null) {
        const wData = solRow.windows[w];
        if (wData) {
          solanaFees = (wData.txCount * wData.avgPlatformFeeLamports) / 1e9 * solPrice;
        }
      }
      windows[w] = {
        solana: solanaFees,
        ethereum: ethFees,
        bsc: bscFees,
        base: baseFees,
        total: (solanaFees ?? 0) + evmTotal,
      };
    }

    return {
      meta,
      windows,
      stableOnly: {
        ethereum: ethChain?.coverage === "stable-only",
        bsc: bscChain?.coverage === "stable-only",
        base: baseChain?.coverage === "stable-only",
      },
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
        <TradingAppsLeaderboard rows={rows} updatedAt={updatedAt} />
      </div>

      <p className="mt-6 text-xs text-ink-muted leading-relaxed max-w-2xl">
        Solana fees = <span className="font-mono">txCount × avgPlatformFeeLamports / 1e9 × SOL price</span>.
        EVM fees = stable (USDC/USDT) + native where traceable, always 24h.
      </p>

      {evmData && evmData.platforms.length > 0 && (
        <div className="mt-10 border-t border-rule pt-8">
          <RevenueSummary evm={evmData} />
        </div>
      )}

      <div className="mt-10">
        <ExecChainTabs solanaData={solanaData} evmData={evmData} />
      </div>

      <div className="mt-8 text-xs text-ink-muted leading-relaxed max-w-2xl space-y-2">
        <p><strong>Priority fee</strong> = total transaction fee minus the 5 000-lamport base fee per signature.</p>
        <p><strong>CU price</strong> = priority fee ÷ compute units consumed (microlamports/CU). p50/p95 shows median and tail pressure.</p>
        <p><strong>Jito rate</strong> = fraction of transactions tipping one of the 8 official Jito tip accounts.</p>
        <p><strong>Platform fee</strong> = average SOL transferred to the platform&apos;s fee account per transaction.</p>
        <p>Source: standard Solana JSON-RPC. Passive monitoring — no synthetic trades, no on-chain footprint.</p>
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
              <p className="text-sm font-medium text-ink group-hover:text-accent transition-colors">Execution Quality</p>
              <p className="text-xs text-ink-muted">Priority fees, Jito rates, platform fees</p>
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
