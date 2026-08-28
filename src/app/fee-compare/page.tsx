import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { FeeCompareClient } from "@/components/fee-compare-client";

export const metadata: Metadata = pageMetadata({
  path: "/fee-compare",
  title: "Perp DEX fee comparison — any venue",
  description:
    "Compare taker fees between any two perp DEXs. Paste a wallet to see what was actually paid on Hyperliquid or Gains and what it would have cost elsewhere. Live on-chain data, no API key.",
});

const VALID_VENUES = new Set(["hyperliquid", "gains", "dydx", "gmx-v2", "paradex", "edgex"]);

export default async function FeeComparePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;

  const rawA = params.venueA ?? "hyperliquid";
  const rawB = params.venueB ?? "gains";
  const initialVenueA = VALID_VENUES.has(rawA) ? rawA : "hyperliquid";
  const initialVenueB = VALID_VENUES.has(rawB) && rawB !== initialVenueA ? rawB : "gains";
  const initialWallet = /^0x[0-9a-fA-F]{40}$/.test(params.wallet ?? "") ? params.wallet! : "";
  const rawDays = parseInt(params.days ?? "90", 10);
  const initialDays = isFinite(rawDays) ? Math.min(180, Math.max(7, rawDays)) : 90;

  return (
    <article className="mx-auto max-w-[720px] px-4 sm:px-6 py-10 sm:py-14">
      <p className="font-sans text-[11px] uppercase tracking-[0.18em] text-ink-faint mb-3">
        Fee comparison
      </p>
      <h1 className="display text-3xl sm:text-4xl text-ink leading-[1.05]">
        Compare perp DEX fees
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        Select any two venues to compare taker rates. When comparing Hyperliquid or Gains,
        paste a wallet address to see real fees from your trade history and what those same
        trades would have cost on the other platform.
      </p>
      <p className="mt-2 text-sm text-ink-faint">
        No API key required. Rates fetched live from public endpoints.
      </p>

      <div className="mt-8">
        <FeeCompareClient
          initialVenueA={initialVenueA as "hyperliquid"}
          initialVenueB={initialVenueB as "gains"}
          initialWallet={initialWallet}
          initialDays={initialDays}
        />
      </div>
    </article>
  );
}
