import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import { readSnapshot } from "@/lib/snapshot";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

const DESCRIPTION =
  "Live benchmarks for Solana trading platforms and Telegram bots — volume, fees, execution quality, unique traders, and app store ratings.";

export const metadata: import("next").Metadata = pageMetadata({
  path: "/trading-apps",
  title: "Best Solana Trading Apps 2026, ranked by benchmark",
  description: DESCRIPTION,
});

export const revalidate = 60;

const BENCH_SLUGS = [
  "solana-trading-platform-wars",
  "solana-dex-volume",
  "solana-unique-traders",
  "solana-avg-trade-size",
  "solana-launchpad-wars",
  "memecoin-platforms",
  "trading-app-execution",
  "app-store-ratings",
] as const;

const PRODUCTS = [
  {
    slug: "pump-fun",
    name: "pump.fun",
    description: "Leading Solana memecoin launchpad and AMM",
  },
  {
    slug: "fomo",
    name: "FOMO",
    description: "Multi-chain memecoin trading with social copy-trading",
  },
  {
    slug: "gmgn",
    name: "GMGN",
    description: "Memecoin terminal with smart money tracking and Telegram bot",
  },
  {
    slug: "axiom",
    name: "Axiom",
    description: "Telegram trading bot for Solana memecoins",
  },
  {
    slug: "trojan",
    name: "Trojan",
    description: "Fast Solana Telegram bot with sniping and MEV protection",
  },
  {
    slug: "photon",
    name: "Photon",
    description: "Advanced Solana trading terminal with wallet tracking",
  },
  {
    slug: "maestro",
    name: "Maestro",
    description: "Multi-chain Telegram trading bot with limit orders",
  },
  {
    slug: "banana-gun",
    name: "Banana Gun",
    description: "Multi-chain Telegram bot for memecoins and EVM tokens",
  },
  {
    slug: "bullx",
    name: "BullX",
    description: "Multi-chain terminal for memecoins on Solana and EVM",
  },
] as const;

const GROUPS = [
  {
    label: "Volume & activity",
    items: [
      {
        slug: "solana-trading-platform-wars",
        title: "Trading platform volume",
        description:
          "24h volume for pump.fun, GMGN, Axiom, FOMO and Telegram bots",
      },
      {
        slug: "solana-dex-volume",
        title: "DEX volume & protocol revenue",
        description: "24h trading volume and protocol fees from DeFiLlama",
      },
      {
        slug: "solana-unique-traders",
        title: "Unique traders",
        description: "Unique swap transactions per platform in the last 24h",
      },
      {
        slug: "solana-avg-trade-size",
        title: "Average trade size",
        description: "Average swap size in USD per platform",
      },
    ],
  },
  {
    label: "Launchpads",
    items: [
      {
        slug: "solana-launchpad-wars",
        title: "Launchpad volume",
        description:
          "24h volume for pump.fun, Flap, Bankr and other bonding-curve programs",
      },
    ],
  },
  {
    label: "Fees & execution",
    items: [
      {
        slug: "memecoin-platforms",
        title: "Platform fee rates",
        description:
          "Protocol fee revenue divided by volume — who earns most per dollar traded",
      },
      {
        slug: "trading-app-execution",
        title: "Execution quality",
        description:
          "Priority fees, Jito bundle rates, CU price and platform fee per transaction",
      },
    ],
  },
  {
    label: "App store",
    items: [
      {
        slug: "app-store-ratings",
        title: "iOS app store ratings",
        description:
          "Live Apple App Store ratings for Coinbase, Robinhood, Crypto.com and more",
      },
    ],
  },
] as const;

function fmtUSD(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(0)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

export default async function TradingAppsHubPage() {
  const [volumeSnap, ratingsSnap] = await Promise.all([
    readSnapshot("solana-trading-platform-wars"),
    readSnapshot("app-store-ratings"),
  ]);

  const topVolumePlatform = volumeSnap?.results[0];
  const topRatedApp = ratingsSnap?.results[0];
  const platformsTracked = new Set(
    PRODUCTS.map((p) => p.slug)
  ).size;

  const breadcrumbLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Trading Apps", item: `${SITE.url}/trading-apps` },
    ]),
  };

  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Trading app benchmarks by OpenChainBench",
    description: DESCRIPTION,
    numberOfItems: BENCH_SLUGS.length,
    itemListElement: BENCH_SLUGS.map((slug, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: slug,
      url: `${SITE.url}/benchmarks/${slug}`,
    })),
  };

  return (
    <article
      className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16"
      style={{
        background:
          "linear-gradient(180deg, rgba(16,185,129,0.06), rgba(16,185,129,0) 320px)",
      }}
    >
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListLd) }}
      />

      <header className="mb-8">
        <p
          className="label-mono text-emerald-600 mb-2"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          Trading Apps
        </p>
        <h1 className="display text-4xl sm:text-5xl text-ink">
          Solana trading app benchmarks
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Eight independent benchmarks across four categories: 24h platform
          volume, launchpad activity, execution fees, and app store ratings.
          Every number is measured live from the same harness on the same
          schedule. No marketing claims, just on-chain data.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          {BENCH_SLUGS.slice(0, 5).map((slug) => (
            <Link
              key={slug}
              href={`/benchmarks/${slug}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/8 px-3 py-1 hover:bg-emerald-500/14 transition-colors"
            >
              <span
                className="label-mono text-ink-faint text-[10px]"
                style={{ fontFamily: "var(--font-mono, monospace)" }}
              >
                Bench
              </span>
              <span className="text-ink text-[11px]">{slug}</span>
            </Link>
          ))}
          {BENCH_SLUGS.length > 5 && (
            <span className="text-[11px] text-ink-faint">
              +{BENCH_SLUGS.length - 5} more
            </span>
          )}
        </div>
      </header>

      {/* KPI strip */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10">
        <KpiCard
          label="Top volume platform"
          value={
            topVolumePlatform
              ? `${topVolumePlatform.name} · ${fmtUSD(topVolumePlatform.ms.mean)}`
              : "..."
          }
          accent="#10b981"
          tip="Platform with highest 24h volume on solana-trading-platform-wars."
        />
        <KpiCard
          label="Top-rated app"
          value={
            topRatedApp
              ? `${topRatedApp.name} · ${topRatedApp.ms.mean.toFixed(2)}`
              : "..."
          }
          accent="#f59e0b"
          tip="Highest Apple App Store rating on app-store-ratings."
        />
        <KpiCard
          label="Platforms tracked"
          value={String(platformsTracked)}
          accent="#6366f1"
        />
        <KpiCard
          label="Active benchmarks"
          value={String(BENCH_SLUGS.length)}
        />
      </section>

      {/* Product grid */}
      <section className="mb-12">
        <p
          className="label-mono text-[10px] text-ink-faint mb-4 uppercase tracking-wide"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          Platforms covered
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {PRODUCTS.map((product) => (
            <Link
              key={product.slug}
              href={`/products/${product.slug}`}
              className="group card-soft rounded-lg border border-ink/10 p-3 sm:p-4 hover:border-emerald-500/30 hover:bg-emerald-500/4 transition-colors"
            >
              <div className="flex items-center gap-2.5 mb-2">
                <ProviderLogo slug={product.slug} name={product.name} size={28} />
                <span className="text-sm font-medium text-ink group-hover:text-emerald-700 transition-colors leading-tight">
                  {product.name}
                </span>
              </div>
              <p className="text-[11px] text-ink-faint leading-snug">
                {product.description}
              </p>
            </Link>
          ))}
        </div>
      </section>

      {/* Benchmarks grouped list */}
      <section>
        <p
          className="label-mono text-[10px] text-ink-faint mb-4 uppercase tracking-wide"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          Benchmarks
        </p>
        <div className="space-y-10">
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
      </section>

      <footer className="mt-16 pt-6 border-t border-ink/10 text-[12px] text-ink-soft leading-relaxed">
        <p
          className="label-mono text-ink-faint mb-2"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          Methodology
        </p>
        <p className="max-w-3xl">
          Volume figures are pulled from on-chain program activity and
          DeFiLlama aggregates. Platform fee rates compare fee revenue to
          reported volume over the same 24h window. Execution quality probes
          submit a representative transaction per platform and records the
          priority fee, Jito bundle cost, and compute unit price. App store
          ratings are fetched directly from the Apple App Store API. All
          harnesses are open source on{" "}
          <Link
            href="https://github.com/ChainBench/OpenChainBench"
            className="underline hover:text-ink"
            rel="noopener noreferrer"
            target="_blank"
          >
            GitHub
          </Link>
          . Data released under{" "}
          <Link
            href="https://creativecommons.org/licenses/by/4.0/"
            className="underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            CC BY 4.0
          </Link>
          .
        </p>
      </footer>
    </article>
  );
}

function KpiCard({
  label,
  value,
  accent,
  tip,
}: {
  label: string;
  value: string;
  accent?: string;
  tip?: string;
}) {
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15"
      title={tip}
    >
      <p
        className="label-mono text-[10px] text-ink-faint mb-1 flex items-center gap-1.5"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {accent && (
          <span
            className="inline-block w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: accent }}
          />
        )}
        {label}
      </p>
      <p className="text-base sm:text-xl font-semibold tabular-nums leading-tight text-ink">
        {value}
      </p>
    </div>
  );
}
