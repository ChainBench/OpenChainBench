import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { fetchExecLeaderboard } from "@/lib/solana-exec";
import { fetchEVMRevenue } from "@/lib/evm-exec";
import { RevenueSummary } from "@/components/revenue-summary";
import { ExecChainTabs } from "@/components/exec-chain-tabs";

const DESCRIPTION =
  "Solana trading platform execution quality: priority fees, Jito bundle rates, and platform fees — measured passively from on-chain data. Updated every hour.";

export const metadata: Metadata = pageMetadata({
  path: "/apps/exec",
  title: "Execution Quality — pump.fun, FOMO, Axiom, GMGN | OpenChainBench",
  description: DESCRIPTION,
});

export const revalidate = 60;

export default async function ExecPage() {
  const [solanaData, evmData] = await Promise.all([
    fetchExecLeaderboard(),
    fetchEVMRevenue(),
  ]);

  const breadcrumb = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Apps", item: `${SITE.url}/apps` },
      { name: "Execution", item: `${SITE.url}/apps/exec` },
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
        Execution quality.
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        {DESCRIPTION}
      </p>

      {evmData && evmData.platforms.length > 0 && (
        <div className="mt-8">
          <RevenueSummary evm={evmData} />
        </div>
      )}

      <div className="mt-10">
        <ExecChainTabs solanaData={solanaData} evmData={evmData} />
      </div>

      <div className="mt-8 text-xs text-ink-muted leading-relaxed max-w-2xl space-y-2">
        <p>
          <strong>Priority fee</strong> = total transaction fee minus the 5 000-lamport base fee
          per signature. Paid by the user to compete for block space.
        </p>
        <p>
          <strong>CU price</strong> = priority fee ÷ compute units consumed (microlamports/CU).
          p50/p95 shows median and tail pressure on each platform.
        </p>
        <p>
          <strong>Jito rate</strong> = fraction of transactions that include a SOL tip to one of
          the 8 official Jito tip accounts. Higher = more MEV-sensitive routing.
        </p>
        <p>
          <strong>Platform fee</strong> = average SOL transferred to the platform&apos;s fee account
          per transaction.
        </p>
        <p>
          Source: standard Solana JSON-RPC. Passive monitoring via fee-account attribution —
          no synthetic trades, no on-chain footprint.
        </p>
      </div>
    </article>
  );
}
