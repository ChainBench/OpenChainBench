import type { Metadata } from "next";
import { LiveDashboard } from "@/components/live-dashboard";

export const metadata: Metadata = {
  title: "Live · OpenChainBench",
  description:
    "Real-time stream of swap events across major chains, with global market stats refreshed continuously.",
};

export default function LivePage() {
  return (
    <>
      <section className="px-4 pt-16 sm:pt-20 pb-2">
        <div className="mx-auto max-w-6xl">
          <h1 className="display text-3xl sm:text-4xl md:text-5xl text-ink max-w-4xl">
            Onchain, live.
          </h1>
          <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
            Real swap events, streamed as they happen on Ethereum, Solana, Base, BSC and
            Arbitrum. Global stats refresh every few minutes from Mobula&apos;s indexers.
          </p>
        </div>
      </section>

      <section className="px-4 pt-12 pb-12 sm:pt-16 sm:pb-16">
        <div className="mx-auto max-w-6xl">
          <LiveDashboard />
        </div>
      </section>
    </>
  );
}
