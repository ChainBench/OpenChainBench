import type { Metadata } from "next";
import Link from "next/link";
import { PerpCostClient } from "@/components/perp-cost-client";
import { buildBreadcrumbJsonLd, safeJsonLd } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/page-metadata";
import { MEASURED_AT, NOT_SHOWN, VENUES } from "@/lib/perp-cost-model";
import { SITE } from "@/data/site";

const TITLE = "Perp leverage cost: fees, spread and liquidation";
const DESCRIPTION =
  "What ten perp venues take from the same leveraged trade: taker fee, half the quoted spread, and the move where a fee on the gain beats one on notional.";

export const metadata: Metadata = pageMetadata({
  path: "/tools/perp-cost",
  title: TITLE,
  description: DESCRIPTION,
});

export default function PerpCostToolPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      buildBreadcrumbJsonLd([
        { name: "Home", item: SITE.url },
        { name: "Tools", item: `${SITE.url}/tools` },
        { name: "Perp leverage cost", item: `${SITE.url}/tools/perp-cost` },
      ]),
      {
        "@type": "WebApplication",
        "@id": `${SITE.url}/tools/perp-cost#app`,
        name: "Perp leverage cost calculator",
        url: `${SITE.url}/tools/perp-cost`,
        applicationCategory: "FinanceApplication",
        operatingSystem: "Web",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        description: DESCRIPTION,
        publisher: { "@id": `${SITE.url}/#org` },
      },
    ],
  };

  return (
    <article className="mx-auto max-w-[920px] px-4 py-10 sm:px-6 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />

      <p className="mb-3 font-sans text-[11px] uppercase tracking-[0.18em] text-ink-faint">
        Tools
      </p>
      <h1 className="display text-3xl leading-[1.05] text-ink sm:text-4xl">
        What a leveraged trade actually costs you
      </h1>
      <p className="mt-4 max-w-2xl text-base leading-snug text-ink-soft">
        Nine of the ten products below charge a share of your <em>notional</em>, twice, whether you
        win or lose. Papertrade charges a share of your <em>gain</em>, once, and nothing if there is
        no gain. No single fee rate can hold both, so this computes what each one takes from the
        same trade. Drag the price move: the order changes, and where it changes is the answer.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-ink-faint">
        Cohort-wide rankings of taker fee, spread and impact live on the{" "}
        <Link href="/perps" className="underline">
          perp DEX leaderboard
        </Link>
        , and the maximum-leverage terms behind the liquidation column are the{" "}
        <Link href="/benchmarks/perp-max-leverage-terms" className="underline">
          leverage terms benchmark
        </Link>
        .
      </p>

      <div className="mt-8">
        <PerpCostClient />
      </div>

      <footer className="mt-10 border-t border-rule pt-6 text-[13px] leading-relaxed text-ink-faint">
        <h2 className="display mb-3 text-lg text-ink">How these numbers were read</h2>

        <p className="mb-3">
          <strong className="font-semibold text-ink">Fees and spreads</strong> come from our own
          perp-fees measurements, read on {MEASURED_AT}. Each spread is one quoted book at a single
          tick rather than an average over a window, and half of it is charged per leg because a
          taker crosses half the book. Two rows carry no spread, for different reasons:{" "}
          <strong className="font-semibold text-ink">Papertrade</strong> quotes one price and
          charges nothing to cross it, and <strong className="font-semibold text-ink">GMX v2</strong>{" "}
          has no book at all, so what a taker pays there is price impact against the pool, which
          this page excludes. <strong className="font-semibold text-ink">Maintenance
          requirements</strong> are marked by provenance in the liquidation column:{" "}
          <ProvenanceTag>api</ProvenanceTag> read from the venue&apos;s own endpoint,{" "}
          <ProvenanceTag>chain</ProvenanceTag> read from its contracts,{" "}
          <ProvenanceTag>docs</ProvenanceTag> derived from a documented rule rather than a published
          field. The figures are fixed in the page at that date, not polled live.
        </p>

        <p className="mb-3">
          <strong className="font-semibold text-ink">Gains</strong>, Arbitrum diamond{" "}
          <code className="font-mono text-xs">0xFF162c69…F169</code>:{" "}
          <code className="font-mono text-xs">pairs()</code> word 9 gives the fee index and{" "}
          <code className="font-mono text-xs">fees()</code> word 0 the position-size fee at 1e10.
          Standard pairs read a 0.0350% taker a leg with a 0.0100% pair spread and run 1.1x to 200x;
          the x500 degen pairs read 0.0200% with no spread, and both{" "}
          <code className="font-mono text-xs">pairMinLeverage</code> and{" "}
          <code className="font-mono text-xs">pairMaxLeverage</code> read 500x, so that product is
          fixed at 500x rather than capped there. The liquidation threshold also comes off chain,
          from <code className="font-mono text-xs">getPairLiquidationParams()</code>: standard pairs
          give up 90% of collateral at or below 25x and 75% at or above 60x, interpolated linearly
          in between, while the degen pairs read 80% flat. The fee sits inside that trigger, so the
          room shown subtracts both fee legs from it. On the degen pairs the 80% threshold models a
          room of 0.1200% at 500x, which is the figure the table renders; eleven real liquidations
          fired at a median 59.4% of collateral instead, which works out at 0.1189%.
        </p>

        <p className="mb-3">
          <strong className="font-semibold text-ink">Papertrade&apos;s</strong> haircut is its own
          published formula,{" "}
          <code className="font-mono text-xs [overflow-wrap:anywhere]">
            scale = (1 - baseRate) / (1 + 1/(move x rateMultiplier) + referenceNotional/(10^6 x move
            x positionMultiplier))
          </code>
          , with baseRate 10%, rateMultiplier 15,000, referenceNotional $100,000 and
          positionMultiplier 814.598 on BTC and 483.979 on ETH, then a 0.2 bps deadband and a 2% win
          fee. Its bust buffer comes from <code className="font-mono text-xs">/state/trading</code>{" "}
          and is an offset before the zero-equity price, so the room is one over the leverage minus
          the buffer, not the buffer itself. The haircut uses a constant reference notional rather
          than your position size, by design, so it does not vary with how much you trade.
        </p>

        <p className="mb-3">
          <strong className="font-semibold text-ink">Not shown.</strong>{" "}
          {NOT_SHOWN.map((v, i) => (
            <span key={v.name}>
              {i > 0 ? " " : ""}
              {v.name}: {v.reason}.
            </span>
          ))}{" "}
          A missing row beats a wrong one on a page of money figures.
        </p>

        <p className="mb-3">
          <strong className="font-semibold text-ink">Excluded from every figure:</strong> funding,
          borrowing, GMX&apos;s price impact, and the closing fee and spread charged at liquidation.
          All of them move the real trigger closer than shown, and the longer a position is held the
          more they matter. edgeX and GMX also tier their maintenance requirement by position size
          and open interest; the base tier is used here. The model covers{" "}
          {VENUES.length} products across {new Set(VENUES.map((v) => v.name)).size} venues, on BTC
          and ETH only.
        </p>
      </footer>
    </article>
  );
}

function ProvenanceTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-sans text-[10px] uppercase tracking-[0.1em] text-ink-muted">
      {children}
    </span>
  );
}
