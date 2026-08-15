import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

const DESCRIPTION =
  "Live benchmarks for Solana trading platforms and Telegram bots — volume, fees, execution quality, unique traders, and app store ratings.";

export const metadata: Metadata = pageMetadata({
  path: "/trading-apps",
  title: "Trading App Benchmarks — pump.fun, Axiom, GMGN, FOMO | OpenChainBench",
  description: DESCRIPTION,
});

export const revalidate = 3600;

const GROUPS = [
  {
    label: "Volume & activity",
    items: [
      {
        slug: "solana-trading-platform-wars",
        title: "Trading platform volume",
        description: "24h volume for pump.fun, GMGN, Axiom, FOMO and Telegram bots. Updated every 15 min.",
      },
      {
        slug: "solana-dex-volume",
        title: "DEX volume & protocol revenue",
        description: "24h trading volume and protocol fees from DeFiLlama. Updated every 30 min.",
      },
      {
        slug: "solana-unique-traders",
        title: "Unique traders",
        description: "Unique swap transactions per platform in the last 24h. Whale vs retail signal.",
      },
      {
        slug: "solana-avg-trade-size",
        title: "Average trade size",
        description: "Average swap size in USD per platform — reveals trader profile.",
      },
    ],
  },
  {
    label: "Launchpads",
    items: [
      {
        slug: "solana-launchpad-wars",
        title: "Launchpad volume",
        description: "24h volume for pump.fun, Flap, Bankr and other bonding-curve programs.",
      },
    ],
  },
  {
    label: "Fees & execution",
    items: [
      {
        slug: "memecoin-platforms",
        title: "Platform fee rates",
        description: "Protocol fee revenue divided by volume — who earns most per dollar traded.",
      },
      {
        slug: "trading-app-execution",
        title: "Execution quality",
        description: "Priority fees, Jito bundle rates, CU price and platform fee per transaction.",
      },
    ],
  },
  {
    label: "App store",
    items: [
      {
        slug: "app-store-ratings",
        title: "iOS app store ratings",
        description: "Live Apple App Store ratings for Coinbase, Robinhood, Crypto.com and more. Updated every 30 min.",
      },
    ],
  },
];

export default function TradingAppsHubPage() {
  const breadcrumb = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Trading Apps", item: `${SITE.url}/trading-apps` },
    ]),
  };

  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Trading app benchmarks — OpenChainBench",
    numberOfItems: GROUPS.reduce((n, g) => n + g.items.length, 0),
    itemListElement: GROUPS.flatMap((g, gi) =>
      g.items.map((item, ii) => ({
        "@type": "ListItem",
        position: GROUPS.slice(0, gi).reduce((n, g2) => n + g2.items.length, 0) + ii + 1,
        name: item.title,
        url: `${SITE.url}/benchmarks/${item.slug}`,
      }))
    ),
  };

  return (
    <article className="mx-auto max-w-[900px] px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(itemList) }}
      />

      <h1 className="display text-3xl sm:text-4xl text-ink leading-[1.05]">
        Trading app benchmarks.
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        {DESCRIPTION}
      </p>

      <div className="mt-12 space-y-10">
        {GROUPS.map((group) => (
          <div key={group.label}>
            <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-3">
              {group.label}
            </p>
            <div className="flex flex-col">
              {group.items.map((item, i) => (
                <div key={item.slug}>
                  {i > 0 && <div className="border-t border-rule" />}
                  <Link
                    href={`/benchmarks/${item.slug}`}
                    className="flex items-center justify-between py-4 group"
                  >
                    <div className="min-w-0 pr-4">
                      <span className="text-sm font-medium text-ink group-hover:text-accent transition-colors">
                        {item.title}
                      </span>
                      <span className="block mt-0.5 text-xs text-ink-faint leading-snug">
                        {item.description}
                      </span>
                    </div>
                    <svg
                      className="text-ink-faint group-hover:text-ink-muted transition-colors shrink-0"
                      width="14"
                      height="14"
                      viewBox="0 0 12 12"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M3.5 3H2a1 1 0 00-1 1v6a1 1 0 001 1h6a1 1 0 001-1V8.5M7 1h4m0 0v4m0-4L5.5 6.5"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </Link>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
