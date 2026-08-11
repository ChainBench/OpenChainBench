import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd, buildFaqPageJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { fetchExecLeaderboard } from "@/lib/solana-exec";
import { fetchEVMRevenue } from "@/lib/evm-exec";
import { ExecChainTabs } from "@/components/exec-chain-tabs";

export const revalidate = 60;

export const metadata: Metadata = pageMetadata({
  path: "/benchmarks/trading-app-execution",
  title: "Trading App Execution Quality — Axiom vs GMGN vs Trojan vs Maestro | OpenChainBench",
  description:
    "Compare on-chain execution quality for Solana trading apps: avg platform fee, priority fee, Jito bundle rate, CU price. Axiom vs GMGN vs Trojan vs Maestro — measured passively from fee accounts, updated hourly.",
});

const FAQ = [
  {
    q: "What is platform fee vs priority fee?",
    a: "Priority fee is paid to Solana validators to compete for block space — it does not go to the trading app. Platform fee is the SOL transferred to the trading app's own fee wallet per transaction, which is the actual revenue the platform captures from each trade.",
  },
  {
    q: "How is transaction count measured?",
    a: "Tx count comes from getSignaturesForAddress on the platform's fee wallet(s), giving the total number of transactions that sent fees to that address. This is the full population count, not a sample — the 100-tx sample is used only for fee amount and CU metrics.",
  },
  {
    q: "Why does Trojan show a near-zero Jito rate?",
    a: "Trojan does not appear to use Jito MEV bundles for its standard execution path, consistent with its design as a Telegram bot that prioritises simplicity over MEV protection.",
  },
  {
    q: "Why are EVM revenues lower than Solana revenues?",
    a: "Most platforms primarily target Solana users. EVM fee collection varies: some platforms charge mostly in native ETH/BNB via internal transactions which are not traceable without a trace API. The EVM figures reflect directly visible USDC and native transfers only.",
  },
  {
    q: "How often is data updated?",
    a: "Solana metrics update every 5 minutes (materialiser cycle). EVM revenue updates block-by-block continuously. The timestamp in the table header reflects the last materialiser run.",
  },
];

export default async function TradingAppExecutionPage() {
  const [solanaData, evmData] = await Promise.all([
    fetchExecLeaderboard(),
    fetchEVMRevenue(),
  ]);

  const breadcrumb = buildBreadcrumbJsonLd([
    { name: "Home", item: SITE.url },
    { name: "Benchmarks", item: `${SITE.url}/benchmarks` },
    { name: "Trading App Execution", item: `${SITE.url}/benchmarks/trading-app-execution` },
  ]);

  const faqJsonLd = buildFaqPageJsonLd(
    FAQ,
    `${SITE.url}/benchmarks/trading-app-execution`,
  );

  return (
    <article className="mx-auto max-w-[900px] px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd({ "@context": "https://schema.org", ...breadcrumb }) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(faqJsonLd) }}
      />

      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-xs text-ink-muted mb-6 font-mono">
        <Link href="/" className="hover:text-ink-soft transition-colors">Home</Link>
        <span>/</span>
        <Link href="/benchmarks" className="hover:text-ink-soft transition-colors">Benchmarks</Link>
        <span>/</span>
        <span className="text-ink">Trading App Execution</span>
      </nav>

      {/* Header */}
      <div className="flex items-start gap-3 flex-wrap">
        <span
          className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium text-white shrink-0 mt-0.5"
          style={{ backgroundColor: "#a05688" }}
        >
          Trading
        </span>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20 shrink-0 mt-0.5">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          Live
        </span>
      </div>

      <h1 className="display text-3xl sm:text-4xl text-ink leading-[1.05] mt-3">
        Trading app execution quality.
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        Passive on-chain execution metrics for the top Solana trading apps and Telegram bots.
        Priority fee, Jito rate, CU price, and platform fee per transaction — measured directly
        from fee accounts, no synthetic trades. EVM chain revenue on the chain tabs below.
      </p>

      <div className="mt-10">
        <ExecChainTabs solanaData={solanaData} evmData={evmData} />
      </div>

      {/* Methodology */}
      <div className="mt-10 border-t border-rule pt-8 text-xs text-ink-muted leading-relaxed max-w-2xl space-y-2">
        <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-3">Methodology</p>
        <p>
          <strong>Priority fee</strong> = total transaction fee minus the 5 000-lamport base fee per signature. Paid to validators, not to the platform.
        </p>
        <p>
          <strong>CU price</strong> = priority fee ÷ compute units consumed (microlamports/CU). p50/p95 shows median and tail pressure on each platform.
        </p>
        <p>
          <strong>Jito rate</strong> = fraction of transactions tipping one of the 8 official Jito tip accounts. Higher = more MEV-sensitive routing.
        </p>
        <p>
          <strong>Platform fee</strong> = average SOL transferred to the platform's fee account per incoming transaction. This is actual protocol revenue per trade.
        </p>
        <p>
          <strong>Tx count</strong> = total transactions at the fee wallet over the window (getSignaturesForAddress), not a sample. Fee metrics use a 100-tx sample per poll.
        </p>
        <p>
          <strong>EVM</strong> = USDC (ERC-20) + native ETH/BNB direct transfers to each platform's fee address. Base chain: USDC only (no free trace API). Updated block-by-block.
        </p>
        <p className="text-ink-faint">
          Source:{" "}
          <a
            href="https://github.com/ChainBench/OpenChainBench/tree/main/harnesses/solana-exec"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-ink-muted transition-colors"
          >
            github.com/ChainBench/OpenChainBench
          </a>
          . Bench #204.
        </p>
      </div>

      {/* FAQ */}
      <div className="mt-10 border-t border-rule pt-8 max-w-2xl">
        <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-5">FAQ</p>
        <div className="space-y-6">
          {FAQ.map((item) => (
            <div key={item.q}>
              <p className="font-medium text-sm text-ink mb-1">{item.q}</p>
              <p className="text-sm text-ink-soft leading-relaxed">{item.a}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Back link */}
      <div className="mt-10 pt-6 border-t border-rule">
        <Link href="/apps" className="text-sm text-ink-muted hover:text-ink-soft transition-colors">
          ← Back to trading app revenue
        </Link>
      </div>
    </article>
  );
}
