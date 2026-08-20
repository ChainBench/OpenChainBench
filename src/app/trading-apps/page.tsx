import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import { getBenchmark } from "@/data/benchmarks";
import type { ProviderResult } from "@/types/benchmark";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

const DESCRIPTION =
  "Live benchmarks for Solana trading platforms and Telegram bots — volume, swap transactions, average trade size, and app store ratings.";

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
  "app-store-ratings",
] as const;

// pump.fun bonding-curve volume (byLaunchpad) is not comparable to terminal
// byPlatform volumes — it includes trades routed through GMGN/Axiom/Trojan/bots.
// Since pump.fun cut fees to 0% in Aug 2026 they no longer embed a referral tag,
// so UI-only volume cannot be isolated on-chain. Volume shown as — for pump.fun.
// Terminal (slug: padre) is pump.fun's own trading app (acquired Apr 2025,
// formerly Padre). It has its own referral tag and is trackable via byPlatform.
const PLATFORMS = [
  { slug: "pump-fun", name: "pump.fun" },
  { slug: "padre", name: "Terminal" },
  { slug: "gmgn", name: "GMGN" },
  { slug: "axiom", name: "Axiom" },
  { slug: "fomo", name: "FOMO" },
  { slug: "trojan", name: "Trojan" },
  { slug: "photon", name: "Photon" },
  { slug: "maestro", name: "Maestro" },
] as const;

const COLUMNS = [
  {
    key: "volume" as const,
    label: "24h Volume",
    bench: "solana-trading-platform-wars",
    fmt: fmtUSD,
    tip: "Mobula byPlatform attribution via referral tag. pump.fun bonding-curve volume is excluded (shown as —) — it counts all trades on the bonding-curve program regardless of which UI or bot routed them, making it not comparable. Terminal = pump.fun's own trading app (formerly Padre, acquired Apr 2025), tracked via its own referral tag.",
    higherBetter: true,
  },
  {
    key: "traders" as const,
    label: "Swap Tx",
    bench: "solana-unique-traders",
    fmt: fmtCount,
    tip: "Unique swap transactions in 24h via Dune. pump.fun uses dex_solana.trades (all swaps incl. 0-fee). Terminals use fee-wallet detection (fee-generating swaps only). Methods differ.",
    higherBetter: true,
  },
  {
    key: "tradeSize" as const,
    label: "Avg Trade",
    bench: "solana-avg-trade-size",
    fmt: fmtUSD,
    tip: "24h volume ÷ trade count via Mobula. Includes bots and MEV — platforms with heavy bot sniping (notably pump.fun) show lower averages than human-only baselines.",
    higherBetter: true,
  },
  {
    key: "feeRate" as const,
    label: "Fee Rate",
    bench: "memecoin-platforms",
    fmt: fmtPct,
    tip: "Observed take rate: fee revenue ÷ fee-paying volume (Dune tx join). Comparable across platforms. FOMO uses DeFiLlama (includes off-chain relay fees). pump.fun cut trading fees to 0% in Aug 2026.",
    higherBetter: false,
  },
  {
    key: "rating" as const,
    label: "App Rating",
    bench: "app-store-ratings",
    fmt: fmtRating,
    tip: "Apple App Store all-time average rating. Axiom, Trojan, Photon and Maestro have no iOS app — they show —.",
    higherBetter: true,
  },
] as const;

type ColKey = (typeof COLUMNS)[number]["key"];

function indexBySlug(results: ProviderResult[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results ?? []) {
    out[r.slug] = r.ms.p50;
  }
  return out;
}

function fmtUSD(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(0)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtCount(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return v.toFixed(0);
}

function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${v.toFixed(2)}%`;
}

function fmtRating(v: number | null): string {
  if (v === null) return "—";
  return `${v.toFixed(1)} / 5`;
}

const GROUPS = [
  {
    label: "Volume & activity",
    items: [
      { slug: "solana-trading-platform-wars", title: "Trading platform volume" },
      { slug: "solana-dex-volume", title: "DEX volume & protocol revenue" },
      { slug: "solana-unique-traders", title: "Swap transactions" },
      { slug: "solana-avg-trade-size", title: "Average trade size" },
    ],
  },
  {
    label: "Launchpads",
    items: [{ slug: "solana-launchpad-wars", title: "Launchpad volume" }],
  },
  {
    label: "Fees",
    items: [{ slug: "memecoin-platforms", title: "Platform fee rates" }],
  },
  {
    label: "App store",
    items: [{ slug: "app-store-ratings", title: "iOS app store ratings" }],
  },
] as const;

export default async function TradingAppsHubPage() {
  const [volBench, tradersBench, tradeSizeBench, feeBench, ratingsBench] =
    await Promise.all([
      getBenchmark("solana-trading-platform-wars"),
      getBenchmark("solana-unique-traders"),
      getBenchmark("solana-avg-trade-size"),
      getBenchmark("memecoin-platforms"),
      getBenchmark("app-store-ratings"),
    ]);

  const volIdx = indexBySlug(volBench?.results);
  const tradersIdx = indexBySlug(tradersBench?.results);
  const tradeSizeIdx = indexBySlug(tradeSizeBench?.results);
  const feeIdx = indexBySlug(feeBench?.results);
  const ratingIdx = indexBySlug(ratingsBench?.results);

  type Row = {
    slug: string;
    name: string;
    volume: number | null;
    traders: number | null;
    tradeSize: number | null;
    feeRate: number | null;
    rating: number | null;
  };

  const matrix: Row[] = PLATFORMS.map((p) => ({
    slug: p.slug,
    name: p.name,
    // pump.fun cut fees to 0% in Aug 2026 so no referral tag exists — bonding-curve
    // volume is not comparable to terminal byPlatform volumes, show — instead.
    volume: p.slug === "pump-fun" ? null : (volIdx[p.slug] ?? null),
    traders: tradersIdx[p.slug] ?? null,
    tradeSize: tradeSizeIdx[p.slug] ?? null,
    feeRate: feeIdx[p.slug] ?? null,
    rating: ratingIdx[p.slug] ?? null,
  })).sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));

  function best(key: ColKey, higherBetter: boolean): number | null {
    const vals = matrix.map((r) => r[key]).filter((v): v is number => v !== null);
    if (!vals.length) return null;
    return higherBetter ? Math.max(...vals) : Math.min(...vals);
  }

  const bests: Partial<Record<ColKey, number | null>> = {};
  for (const col of COLUMNS) {
    bests[col.key] = best(col.key, col.higherBetter);
  }

  const topVolumeRow = matrix.reduce(
    (b, row) => ((row.volume ?? -1) > (b.volume ?? -1) ? row : b),
    matrix[0],
  );
  const topRating = ratingsBench?.results.find((r: ProviderResult) =>
    PLATFORMS.some((p) => p.slug === r.slug),
  );

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

      <header className="mb-10">
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
          {PLATFORMS.length} platforms measured across {BENCH_SLUGS.length}{" "}
          independent benchmarks: volume, swap transactions, average trade size,
          fee rates, and app store ratings. Live data, no marketing claims.
        </p>
      </header>

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10">
        <KpiCard
          label="Top volume platform"
          value={
            topVolumeRow?.volume != null
              ? `${topVolumeRow.name} · ${fmtUSD(topVolumeRow.volume)}`
              : "Awaiting data"
          }
          accent="#10b981"
        />
        <KpiCard
          label="Top-rated app"
          value={
            topRating
              ? `${topRating.name} · ${topRating.ms.p50.toFixed(1)} / 5`
              : "Awaiting data"
          }
          accent="#f59e0b"
        />
        <KpiCard label="Platforms tracked" value={String(PLATFORMS.length)} accent="#6366f1" />
        <KpiCard label="Active benchmarks" value={String(BENCH_SLUGS.length)} />
      </section>

      <section className="mb-14">
        <p
          className="label-mono text-[10px] text-ink-faint mb-4 uppercase tracking-wide"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          Platform comparison
        </p>
        <div className="overflow-x-auto rounded-lg border border-ink/10">
          <table className="w-full text-sm border-collapse min-w-[560px]">
            <thead>
              <tr className="border-b border-ink/10 bg-ink/3">
                <th className="text-left px-4 py-3 font-medium text-ink-muted text-xs uppercase tracking-wide whitespace-nowrap w-[160px]">
                  Platform
                </th>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className="text-right px-4 py-3 font-medium text-ink-muted text-xs uppercase tracking-wide whitespace-nowrap"
                  >
                    <Link
                      href={`/benchmarks/${col.bench}`}
                      className="inline-flex items-center gap-1 hover:text-ink transition-colors"
                      title={col.tip}
                    >
                      {col.label}
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                        <path
                          d="M3.5 3H2a1 1 0 00-1 1v6a1 1 0 001 1h6a1 1 0 001-1V8.5M7 1h4m0 0v4m0-4L5.5 6.5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((row, i) => (
                <tr
                  key={row.slug}
                  className={`border-b border-ink/6 hover:bg-ink/2 transition-colors ${i % 2 === 1 ? "bg-ink/[0.015]" : ""}`}
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/products/${row.slug}`}
                      className="flex items-center gap-2.5 group"
                    >
                      <ProviderLogo slug={row.slug} name={row.name} size={24} />
                      <span className="font-medium text-ink group-hover:text-emerald-700 transition-colors leading-tight text-sm">
                        {row.name}
                      </span>
                    </Link>
                  </td>
                  {COLUMNS.map((col) => {
                    const val = row[col.key];
                    const isBest = val !== null && val === bests[col.key];
                    return (
                      <td
                        key={col.key}
                        className={`px-4 py-3 text-right tabular-nums text-sm ${
                          val === null
                            ? "text-ink-faint"
                            : isBest
                              ? "font-semibold text-emerald-600 dark:text-emerald-400"
                              : "text-ink"
                        }`}
                      >
                        {col.fmt(val)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-ink-faint">
          Best value per column highlighted in green. Sorted by 24h volume.
          Hover column headers for methodology notes. Data refreshes every 60 s.
        </p>
      </section>

      <section>
        <p
          className="label-mono text-[10px] text-ink-faint mb-4 uppercase tracking-wide"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          All benchmarks
        </p>
        <div className="grid sm:grid-cols-2 gap-x-10 gap-y-8">
          {GROUPS.map((group) => (
            <div key={group.label}>
              <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-3">
                {group.label}
              </p>
              <div className="flex flex-col">
                {group.items.map((item: { slug: string; title: string }, i: number) => (
                  <div key={item.slug}>
                    {i > 0 && <div className="border-t border-rule" />}
                    <Link
                      href={`/benchmarks/${item.slug}`}
                      className="flex items-center justify-between py-3 group"
                    >
                      <span className="text-sm text-ink group-hover:text-accent transition-colors">
                        {item.title}
                      </span>
                      <svg
                        className="text-ink-faint group-hover:text-ink-muted transition-colors shrink-0 ml-3"
                        width="12"
                        height="12"
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
          Volume via Mobula lighthouse byPlatform (referral-tag attribution).
          pump.fun volume shown as — since they cut fees to 0% in Aug 2026 and
          no longer embed a referral tag; bonding-curve totals would mix all UIs
          and bots and are not comparable. Terminal = pump.fun's own trading app
          (formerly Padre, acquired Apr 2025), tracked via its own tag. Swap transaction counts from Dune
          Analytics (pump.fun: dex-level; terminals: fee-wallet detection).
          Average trade size = volume ÷ trade count, includes bots and MEV.
          Fee rate = on-chain fee revenue ÷ fee-paying volume (Dune tx join);
          FOMO via DeFiLlama. App store ratings from the Apple iTunes lookup API.
          All harnesses open source on{" "}
          <Link
            href="https://github.com/ChainBench/OpenChainBench"
            className="underline hover:text-ink"
            rel="noopener noreferrer"
            target="_blank"
          >
            GitHub
          </Link>
          . Data under{" "}
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
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15">
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
