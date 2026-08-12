import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { fetchDeFiLlamaRevenue } from "@/lib/defillama";
import { fetchExecLeaderboard } from "@/lib/solana-exec";
import { TRADING_APPS } from "@/lib/trading-apps-config";
import { TradingAppsLeaderboard, type UnifiedAppRow } from "@/components/trading-apps-leaderboard";
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
  const [dlData, solanaData] = await Promise.all([
    fetchDeFiLlamaRevenue(),
    fetchExecLeaderboard(),
  ]);

  const rows: UnifiedAppRow[] = TRADING_APPS.map((meta) => {
    const dl = dlData.get(meta.id);
    const chain24h = dl?.chain24h ?? {};

    const solanaFees = chain24h["solana"] ?? null;
    const ethFees = chain24h["ethereum"] ?? null;
    const bscFees = chain24h["bsc"] ?? null;
    const baseFees = chain24h["base"] ?? null;

    const windows: UnifiedAppRow["windows"] = {};
    for (const w of WINDOWS) {
      windows[w] = {
        solana: solanaFees,
        ethereum: ethFees,
        bsc: bscFees,
        base: baseFees,
        total: dl ? (w === "24h" ? dl.total24h : w === "7d" ? dl.total7d : dl.total30d) : 0,
      };
    }

    return {
      meta,
      windows,
      stableOnly: { ethereum: false, bsc: false, base: false },
    };
  });

  const updatedAt = solanaData?.updatedAt ?? null;

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

      <p className="mt-4 text-xs text-ink-muted leading-relaxed max-w-2xl">
        Revenue data from <a href="https://defillama.com/fees" target="_blank" rel="noopener noreferrer" className="underline decoration-dotted hover:text-ink-soft">DeFiLlama</a>.
        Chain columns show 24h fees; 7d/30d totals update with window selection.
      </p>

      <div className="mt-10">
        <ExecChainTabs solanaData={solanaData} evmData={null} />
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
