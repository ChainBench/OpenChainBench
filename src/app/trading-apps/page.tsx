import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import { getBenchmark } from "@/data/benchmarks";
import type { ProviderResult } from "@/types/benchmark";
import { TradingAppVolumeSection } from "@/components/trading-app-volume-section";
import { TerminalFillSection } from "@/components/terminal-fill-section";
import { isDevOnlyBench } from "@/lib/removed-benches";
import { ChainBar } from "@/components/chain-bar";
import { computeTradingAppStats, getTradingAppHistory } from "@/lib/trading-app-history";
import {
  TRADING_APP_PLATFORMS as PLATFORMS,
  TRADING_APP_COLUMNS as COLUMNS,
  loadTradingAppMatrix,
} from "@/lib/trading-apps";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { withUtm } from "@/lib/utm";

const DESCRIPTION =
  "Cross-chain daily volume, what each app charges on it, fill quality and app ratings for trading apps and Telegram bots (GMGN, Axiom, FOMO, Photon, Trojan), measured on closed UTC days.";

export const metadata: import("next").Metadata = pageMetadata({
  path: "/trading-apps",
  title: "Trading app benchmarks 2026: volume, commission, fill quality",
  description: DESCRIPTION,
});

export const revalidate = 300; // the fill rows' fetch revalidates at 300 s; an hour here printed a table an hour behind the bench page

const ALL_BENCH_SLUGS = [
  "trading-app-daily-volume",
  "terminal-fill-quality",
  "terminal-execution-quality",
  "solana-trading-platform-wars",
  "terminal-swap-transactions",
  "terminal-avg-trade-size",
  "trading-platform-wallets",
  "launchpad-wars",
  "memecoin-platforms",
  "app-store-ratings",
] as const;
// The ItemList and the "Active benchmarks" count name only the benches this
// deployment serves. Nothing here is gated today; the filter stays because
// gating is a per-deployment fact, not a permanent one.
const BENCH_SLUGS: string[] = ALL_BENCH_SLUGS.filter((slug) => !isDevOnlyBench(slug));


const ALL_GROUPS = [
  {
    label: "Volume & activity",
    items: [
      { slug: "solana-trading-platform-wars", title: "Volume and commission" },
      { slug: "terminal-swap-transactions", title: "Swap transactions" },
      { slug: "terminal-avg-trade-size", title: "Average trade size" },
      { slug: "trading-platform-wallets", title: "Daily active wallets" },
    ],
  },
  {
    // Two readings of the same swap, which is why they sit together. 268 is
    // what the swap cost in total; 279 is the same with the app's own fee
    // removed, so it isolates routing from pricing. A terminal can look
    // expensive on one and excellent on the other, and showing only the first
    // would read as a verdict on execution when it is a verdict on the fee.
    //
    // 268 was in ALL_BENCH_SLUGS without appearing in any group, so it was
    // counted on this page and linked from nowhere. 279 was absent entirely.
    label: "Execution quality",
    items: [
      { slug: "terminal-fill-quality", title: "Cost per swap" },
      { slug: "terminal-execution-quality", title: "Execution loss, fee removed" },
    ],
  },
  {
    label: "Launchpads",
    items: [{ slug: "launchpad-wars", title: "Launchpad volume" }],
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
// A link into a bench this deployment does not serve is a link to a 404, so a
// group loses its gated items and disappears when that empties it.
const GROUPS = ALL_GROUPS.map((g) => ({
  label: g.label,
  items: g.items.filter((i) => !isDevOnlyBench(i.slug)),
})).filter((g) => g.items.length > 0);

export default async function TradingAppsHubPage() {
  const [appMatrix, ratingsBench, history] = await Promise.all([
    loadTradingAppMatrix(),
    getBenchmark("app-store-ratings"),
    getTradingAppHistory(),
  ]);
  // Last-day chain split per app from bench 267, for the chains column of
  // the source table (apps tehcscreener does not cover show a dash).
  const chainSplitOf = new Map<string, { chain: string; usd: number; pct: number }[]>();
  const chainLabelOf = new Map<string, string>();
  if (history)
    for (const s of computeTradingAppStats(history)) {
      chainSplitOf.set(s.app.slug, s.chainSplit);
      if (s.app.chainLabel) chainLabelOf.set(s.app.slug, s.app.chainLabel);
    }

  // The table, its per-column bests and each cell's own formula and chain
  // scope come from the shared loader, so this hub and the "Trading app" view
  // on /products/<slug> cannot drift apart. Columns whose bench this
  // deployment does not serve are already gone from COLUMNS.
  const matrix = appMatrix.rows;
  const bests = appMatrix.bests;
  // The headline KPI names the leader of the first served column that ranks
  // high-is-good, so it does not depend on one particular bench being live.
  // The direction comes from the matrix, which resolved it from each panel's own
  // spec, so this never names a "highest" leader of a column where less is better.
  // Only say these four are paused where they actually are. On staging they are
  // live and the sentence would contradict the table above it. The pairing
  // matters too: 203 is fee rates, 206 average trade size, 207 swap counts.
  //
  // They no longer wait on a Dune plan. They were re-sourced to the public
  // tehcscreener API on 2026-10-07 and are in the staging pipeline for the 24h
  // window and the audit round every bench serves on production after, so say
  // that rather than naming a blocker that has been cleared.
  const pausedNote = isDevOnlyBench("terminal-swap-transactions")
    ? "Benches 203 platform fee rates, 206 average trade size, 207 swap transactions and 232 active wallets were re-sourced on 2026-10-07 and are completing validation on staging. "
    : "";
  const kpiCol = COLUMNS.find(
    (c) =>
      c.rankable !== false &&
      appMatrix.dirs[c.key] &&
      matrix.some((r) => r.values[c.key] !== null),
  );
  const kpiRow = kpiCol
    ? matrix.reduce(
        (bestRow, row) =>
          (row.values[kpiCol.key] ?? -1) > (bestRow.values[kpiCol.key] ?? -1) ? row : bestRow,
        matrix[0],
      )
    : undefined;

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
          Trading app benchmarks
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Swap volume routed through each trading app and Telegram bot, every
          chain summed, per closed UTC day, with the per-chain split and 7 / 30
          day trends. Below it, what each app charged on that volume, how its
          fills came out and how its users rate it. Live data, no marketing
          claims.
        </p>
      </header>

      <section className="mb-14">
        <h2
          className="label-mono text-[10px] text-ink-faint mb-4 uppercase tracking-wide"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          Cross-chain daily volume · bench 267
        </h2>
        <TradingAppVolumeSection />
      </section>

      <section className="mb-14">
        <h2
          className="label-mono text-[10px] text-ink-faint mb-1 uppercase tracking-wide"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          Fill quality · bench 268
        </h2>
        <p className="text-sm text-ink-soft max-w-2xl mb-4">
          What a swap really costs on each terminal: real user transactions read on-chain, valued at the pool&apos;s
          arrival price, split into terminal fee, network, pump.fun and pool costs, plus the share of transactions that fail.
        </p>
        <TerminalFillSection />
      </section>

      <section className="mb-6">
        <h2
          className="label-mono text-[10px] text-ink-faint mb-1 uppercase tracking-wide"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          What each app charges, per platform
        </h2>
        <p className="text-sm text-ink-soft max-w-2xl mb-6">
          The commission each app collected on its latest closed UTC day and the
          take rate that implies, next to how its users rate it. Commission is
          the fees the source reports on its flow, which is more than the app&apos;s own cut and not the
          total fees paid on the trade. Each row covers whatever chains its own
          adapter covers, which the Chains cell shows.
        </p>
      </section>

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10">
        <KpiCard
          label={kpiCol ? `Highest ${kpiCol.label.toLowerCase()}, latest day` : "Latest day"}
          value={
            kpiCol && kpiRow && kpiRow.values[kpiCol.key] != null
              ? `${kpiRow.name} · ${kpiCol.fmt(kpiRow.values[kpiCol.key])}`
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
        <KpiCard label="Platforms tracked" value={String(matrix.length)} accent="#6366f1" />
        <KpiCard label="Active benchmarks" value={String(BENCH_SLUGS.length)} />
      </section>

      <section className="mb-14">
        <h2
          className="label-mono text-[10px] text-ink-faint mb-4 uppercase tracking-wide"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          Platform comparison
        </h2>
        <div className="overflow-x-auto rounded-lg border border-ink/10">
          <table className="w-full text-sm border-collapse min-w-[560px]">
            <thead>
              <tr className="border-b border-ink/10 bg-ink/3">
                <th className="text-left px-4 py-3 font-medium text-ink-muted text-xs uppercase tracking-wide whitespace-nowrap w-[160px]">
                  Platform
                </th>
                <th
                  className="text-left px-4 py-3 font-medium text-ink-muted text-xs uppercase tracking-wide whitespace-nowrap cursor-help"
                  title="Where the app's volume settled on its latest closed UTC day (tehcscreener, bench 267). Dash: not covered by tehcscreener."
                >
                  Chains
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
                      {col.scope === "solana" && (
                        <span className="text-[9px] tracking-[0.12em] text-ink-faint font-normal" title="Every figure in this column covers Solana only">
                          SOL
                        </span>
                      )}
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
                  <td className="px-4 py-3">
                    <ChainBar split={chainSplitOf.get(row.slug) ?? []} width={56} label={chainLabelOf.get(row.slug)} />
                  </td>
                  {COLUMNS.map((col) => {
                    const val = row.values[col.key];
                    const isBest = val !== null && val === bests[col.key];
                    const formula = row.formulas[col.key];
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
                        title={formula ?? undefined}
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
          Best value per column highlighted in green. Sorted by the first column
          where more is better. Volume is in the bench 267 table above (one figure
          per app, cross-chain). Chains from bench 267 (each app&apos;s latest closed
          UTC day), which is also where each row&apos;s breadth is shown. An app with
          no figure in any column is not listed. Hover column headers for
          methodology notes.
        </p>
      </section>

      <section>
        <h2
          className="label-mono text-[10px] text-ink-faint mb-4 uppercase tracking-wide"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          All benchmarks
        </h2>
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
          Volume and fees from the public tehcscreener API, which is Allium-backed,
          per closed UTC day, summed over every chain the adapter covers: ten
          chains for GMGN, three for Axiom, Solana for Trojan and Photon.
          FOMO&apos;s cross-chain trades settle through Relay and are booked on
          Solana, so its figure is its whole business. Commission is the
          app&apos;s own cut (dailyRevenue), not the total fees paid on the trade,
          which is roughly twice as much once the venue underneath takes its
          share; the take rate divides the two over the same days. pump.fun here
          is the launchpad&apos;s mobile app, not its bonding curve. Terminal is
          pump.fun&apos;s own app, formerly Padre. Fill quality from our own
          on-chain swaps, app store ratings from the Apple iTunes lookup API.
          {pausedNote}All harnesses open source on{" "}
          <Link
            href={withUtm("https://github.com/ChainBench/OpenChainBench")}
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
