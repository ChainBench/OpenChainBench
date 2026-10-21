import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageMetadata } from "@/lib/page-metadata";
import { FeeCompareClient } from "@/components/fee-compare-client";
import { SITE } from "@/data/site";

const VALID_SLUGS = ["hyperliquid", "gains", "dydx", "gmx-v2", "paradex", "edgex"] as const;
type VenueSlug = (typeof VALID_SLUGS)[number];

const VENUE_NAMES: Record<VenueSlug, string> = {
  hyperliquid: "Hyperliquid",
  gains: "Gains",
  dydx: "dYdX v4",
  "gmx-v2": "GMX",
  paradex: "Paradex",
  edgex: "EdgeX",
};

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

type Props = { params: Promise<{ venueA: string; venueB: string; wallet: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { venueA, venueB, wallet } = await params;
  if (!VALID_SLUGS.includes(venueA as VenueSlug) || !VALID_SLUGS.includes(venueB as VenueSlug)) {
    return {};
  }
  const a = VENUE_NAMES[venueA as VenueSlug];
  const b = VENUE_NAMES[venueB as VenueSlug];
  return {
    ...pageMetadata({
      path: `/fee-compare/${venueA}/${venueB}/${wallet}`,
      title: `${a} vs ${b} fees for ${short(wallet)}`,
      description: `Fee comparison for wallet ${wallet} on ${a} vs ${b}. Live on-chain data, no API key.`,
    }),
    // Never indexable. The route accepts any 40-hex address, so with six
    // venues and thirty ordered pairs the indexable set is unbounded and
    // every member is a near-duplicate of /fee-compare naming one wallet.
    // Two reasons, and the second is the one that matters: these pages are
    // crawl waste, and /privacy says this site "measures infrastructure, not
    // people". A person's trade history is not ours to put in an index.
    //
    // follow stays true so the links out of the page keep their value, and
    // the canonical points at the tool rather than at itself, because a
    // self-canonical on a noindex page tells a crawler two things at once.
    robots: { index: false, follow: true },
    alternates: { canonical: `${SITE.url}/fee-compare` },
  };
}

export default async function FeeCompareWalletPage({ params }: Props) {
  const { venueA, venueB, wallet } = await params;

  if (
    !VALID_SLUGS.includes(venueA as VenueSlug) ||
    !VALID_SLUGS.includes(venueB as VenueSlug) ||
    venueA === venueB ||
    !/^0x[0-9a-fA-F]{40}$/.test(wallet)
  ) {
    notFound();
  }

  const a = VENUE_NAMES[venueA as VenueSlug];
  const b = VENUE_NAMES[venueB as VenueSlug];

  return (
    <article className="mx-auto max-w-[720px] px-4 sm:px-6 py-10 sm:py-14">
      <p className="font-sans text-[11px] uppercase tracking-[0.18em] text-ink-faint mb-3">
        Fee comparison
      </p>
      <h1 className="display text-3xl sm:text-4xl text-ink leading-[1.05]">
        {a} vs {b}
      </h1>
      <p className="mt-3 font-mono text-sm text-ink-faint break-all">{wallet}</p>
      <p className="mt-3 max-w-2xl text-base text-ink-soft leading-snug">
        Actual fees paid vs what the same trades would have cost on the other platform.
      </p>
      <p className="mt-2 text-sm text-ink-faint">
        Live on-chain data. No API key required.
      </p>

      <div className="mt-8">
        <FeeCompareClient
          initialVenueA={venueA as VenueSlug}
          initialVenueB={venueB as VenueSlug}
          initialWallet={wallet}
        />
      </div>
    </article>
  );
}
