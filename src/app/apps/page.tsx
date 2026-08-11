import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { fetchAppsLeaderboard } from "@/lib/apps-leaderboard";
import { fetchEVMRevenue } from "@/lib/evm-exec";
import { fetchExecLeaderboard } from "@/lib/solana-exec";
import { fetchSolPrice } from "@/lib/sol-price";
import { TRADING_APPS } from "@/lib/trading-apps-config";
import { TradingAppsLeaderboard, type UnifiedAppRow } from "@/components/trading-apps-leaderboard";
import Link from "next/link";

const DESCRIPTION =
  "Protocol fees collected by trading apps: meme bots, telegram bots, and perps. On-chain data, updated hourly.";

export const metadata: Metadata = pageMetadata({
  path: "/apps",
  title: "Trading App Revenue — pump.fun, Axiom, GMGN, Hyperliquid | OpenChainBench",
  description: DESCRIPTION,
});

export const revalidate = 300;

export default async function AppsHubPage() {
  const [perpsData, evmData, solanaData, solPrice] = await Promise.all([
    fetchAppsLeaderboard(),
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

  const perpsBySlug = new Map(
    (perpsData?.protocols ?? []).map((p) => [p.slug, p])
  );

  const rows: UnifiedAppRow[] = TRADING_APPS.map((meta) => {
    if (meta.perpsSlug !== null) {
      const perp = perpsBySlug.get(meta.perpsSlug);
      const gross = perp?.windows["24h"]?.gross ?? 0;
      return {
        meta,
        fees: { solana: null, ethereum: null, bsc: null, base: null },
        stableOnly: { ethereum: false, bsc: false, base: false },
        total24h: gross,
      };
    }

    const evmRow = meta.evmKey ? evmByPlatform.get(meta.evmKey) : undefined;
    const solRow = meta.solanaKey ? solanaByPlatform.get(meta.solanaKey) : undefined;

    const ethChain = evmRow?.chains["ethereum"];
    const bscChain = evmRow?.chains["bsc"];
    const baseChain = evmRow?.chains["base"];

    const ethFees = ethChain ? ethChain.stable24h + (ethChain.native?.usd ?? 0) : null;
    const bscFees = bscChain ? bscChain.stable24h + (bscChain.native?.usd ?? 0) : null;
    const baseFees = baseChain ? baseChain.stable24h + (baseChain.native?.usd ?? 0) : null;

    let solanaFees: number | null = null;
    if (solRow && solPrice !== null) {
      const window24h = solRow.windows["24h"];
      if (window24h) {
        solanaFees = (window24h.txCount * window24h.avgPlatformFeeLamports) / 1e9 * solPrice;
      }
    }

    const total24h =
      (solanaFees ?? 0) + (ethFees ?? 0) + (bscFees ?? 0) + (baseFees ?? 0);

    return {
      meta,
      fees: { solana: solanaFees, ethereum: ethFees, bsc: bscFees, base: baseFees },
      stableOnly: {
        ethereum: ethChain?.coverage === "stable-only",
        bsc: bscChain?.coverage === "stable-only",
        base: baseChain?.coverage === "stable-only",
      },
      total24h,
    };
  });

  const updatedAt =
    evmData?.updatedAt ?? solanaData?.updatedAt ?? perpsData?.updatedAt ?? null;

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
        EVM fees = stable (USDC/USDT) + native where traceable.
        Perps = gross fees 24h from on-chain data.{" "}
        <Link href="/apps/exec" className="underline hover:text-ink-soft transition-colors">
          Detailed execution metrics →
        </Link>
      </p>
    </article>
  );
}
