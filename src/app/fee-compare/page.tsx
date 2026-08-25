import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { FeeCompareClient } from "@/components/fee-compare-client";

export const metadata: Metadata = pageMetadata({
  path: "/fee-compare",
  title: "Hyperliquid vs Gains fee comparison — analyze any wallet",
  description:
    "Paste any wallet address and see exactly what was paid in fees on Hyperliquid or Gains, and what it would have cost on the other platform. Live on-chain data, no API key.",
});

export default function FeeComparePage() {
  return (
    <article className="mx-auto max-w-[720px] px-4 sm:px-6 py-10 sm:py-14">
      <p className="font-sans text-[11px] uppercase tracking-[0.18em] text-ink-faint mb-3">
        Fee comparison
      </p>
      <h1 className="display text-3xl sm:text-4xl text-ink leading-[1.05]">
        Hyperliquid vs Gains
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        Paste a wallet address. We fetch actual fees paid on Hyperliquid
        (fills API) and Gains (on-chain FeesProcessed events, Arbitrum)
        then show what the same trades would have cost on the other platform.
      </p>
      <p className="mt-2 text-sm text-ink-faint">
        No API key required. Data is fetched live from public endpoints.
      </p>

      <div className="mt-8">
        <FeeCompareClient />
      </div>
    </article>
  );
}
