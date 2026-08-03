import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, ExternalLink } from "lucide-react";
import { SITE } from "@/data/site";
import { PERP_VENUES } from "@/lib/perp-stats";
import { PERP_VENUE_META } from "@/lib/perp-venue-context";
import { fetchPerpVenueKpis } from "@/lib/perp-venue-data";
import { fetchPerpCohort } from "@/lib/perp-stats";
import { fetchPerpVenueExternalStats } from "@/lib/perp-venue-external";
import { loadBenchFromBlob } from "@/lib/bench-blob";
import { fmtUnit } from "@/lib/format";
import { PerpVenueKpiStrip } from "@/components/perp-venue-kpi-strip";
import { PerpBarChart } from "@/components/perp-bar-chart";
import { logoPath } from "@/lib/logo-manifest";
import { buildBreadcrumbJsonLd, safeJsonLd } from "@/lib/jsonld";
import type { Benchmark } from "@/types/benchmark";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { slug: string };

const LIVE_PERP_BENCH_SLUGS = [
  "perp-fees",
  "perp-funding",
  "perp-active-markets",
  "perp-execution-quality",
  "perp-mark-price-lag",
  "perp-funding-stability",
  "perp-protocol-longevity",
  "perp-cost-slope",
  "perp-volume-share",
] as const;

function resolveVenue(slug: string) {
  const cohortSlug = slug === "gmx" ? "gmx-v2" : slug;
  const seed = PERP_VENUES.find((v) => v.slug === cohortSlug);
  const meta = PERP_VENUE_META[cohortSlug];
  if (!seed || !meta) return null;
  return { seed, meta, cohortSlug, productSlug: slug };
}

type BenchRanking = {
  benchSlug: string;
  bench: Benchmark;
  rank: number;
  totalRanked: number;
  p50: number;
  hasData: boolean;
};

function buildRankings(
  blobs: (Benchmark | null)[],
  cohortSlug: string,
): BenchRanking[] {
  return LIVE_PERP_BENCH_SLUGS.flatMap((slug, i) => {
    const bench = blobs[i];
    if (!bench) return [];
    const live = bench.results.filter(
      (r) => r.availability !== "unavailable" && !r.unresponsive,
    );
    const sorted = [...live].sort((a, b) =>
      bench.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
    );
    const idx = sorted.findIndex((r) => r.slug === cohortSlug);
    if (idx < 0) return [];
    const result = sorted[idx];
    return [
      {
        benchSlug: slug,
        bench,
        rank: idx + 1,
        totalRanked: sorted.length,
        p50: result.ms.p50,
        hasData: result.ms.p50 > 0,
      },
    ];
  }).sort((a, b) => a.rank - b.rank);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const v = resolveVenue(slug);
  if (!v) return {};

  const title = `${v.seed.name} Stats: Volume, Fees & Funding 2026`;
  const description = `Live ${v.seed.name} statistics on OpenChainBench: volume, open interest, fees, all-in cost and funding rate. Independently measured, refreshed every minute.`;
  const url = `${SITE.url}/perp/${slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, type: "website", url },
    twitter: { card: "summary_large_image", title, description },
  };
}

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return [];
}

function fmtUSD(v: number | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return "-";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtPct(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `${v.toFixed(1)}%`;
}

function fmtCount(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

export default async function PerpVenuePage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const v = resolveVenue(slug);
  if (!v) notFound();

  const { seed, meta, cohortSlug } = v;

  const [, kpis, ext, ...benchBlobs] = await Promise.all([
    fetchPerpCohort(),
    fetchPerpVenueKpis(cohortSlug),
    fetchPerpVenueExternalStats(cohortSlug),
    ...LIVE_PERP_BENCH_SLUGS.map((s) => loadBenchFromBlob(s)),
  ]);

  const rankings = buildRankings(benchBlobs as (Benchmark | null)[], cohortSlug);

  const lastMeasured = rankings.reduce<string | null>((acc, a) => {
    const t = a.bench.lastRunAt;
    if (!t) return acc;
    if (!acc || new Date(t) > new Date(acc)) return t;
    return acc;
  }, null);

  const externalHost = (() => {
    try {
      return new URL(meta.url).host.replace(/^www\./, "");
    } catch {
      return meta.url;
    }
  })();

  const hasChart =
    (ext.dailyVolumeChart?.length ?? 0) >= 3 ||
    (ext.dailyFeesChart?.length ?? 0) >= 3;

  const hasAllTime =
    ext.totalVolumeUsd != null ||
    ext.totalFeesUsd != null ||
    ext.totalTradeCount != null;

  const hasVault =
    ext.vaultTvlUsd != null ||
    ext.stakingAprPct != null ||
    (ext.collateralBreakdown?.length ?? 0) > 0;

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        name: `${seed.name} Stats`,
        url: `${SITE.url}/perp/${slug}`,
        description: `Live ${seed.name} perpetual DEX statistics tracked by OpenChainBench.`,
      },
      buildBreadcrumbJsonLd([
        { name: "Home", item: SITE.url },
        { name: "Perpetuals", item: `${SITE.url}/perps` },
        { name: seed.name, item: `${SITE.url}/perp/${slug}` },
      ]),
    ],
  };

  return (
    <article className="mx-auto max-w-5xl px-6 pt-10 sm:pt-14 pb-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />

      {/* Back */}
      <Link
        href="/perps"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink mb-8"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        All perp venues
      </Link>

      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-ink pb-8 mb-8">
        <div className="flex items-center gap-4 min-w-0">
          {(() => {
            const lp = logoPath(cohortSlug);
            return lp ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={lp} alt={seed.name} width={52} height={52} className="rounded-lg object-contain" />
            ) : (
              <div className="w-[52px] h-[52px] rounded-lg bg-paper-soft border border-rule flex items-center justify-center text-lg font-semibold text-ink-soft shrink-0">
                {seed.name[0]}
              </div>
            );
          })()}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="display text-2xl sm:text-3xl font-semibold tracking-tight">
                {seed.name}
              </h1>
              <span
                className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-md border border-ink/15 text-ink-faint"
                style={{ fontFamily: "var(--font-mono, monospace)" }}
              >
                {seed.chain}
              </span>
            </div>
            <p className="mt-1 text-sm text-ink-muted">
              Perpetual DEX tracked by OpenChainBench
            </p>
          </div>
        </div>
        <a
          href={meta.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink border border-rule rounded-lg px-3 py-2 hover:border-ink/30 transition-colors shrink-0"
        >
          <ExternalLink size={13} strokeWidth={2} />
          {externalHost}
        </a>
      </header>

      {/* Live KPIs */}
      {kpis && (
        <section className="mb-10">
          <p
            className="text-[10px] uppercase tracking-wide text-ink-faint mb-3"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            Live KPIs
          </p>
          <PerpVenueKpiStrip kpis={kpis} />
        </section>
      )}

      {/* Extra KPIs from external API */}
      {(ext.extraKpis?.length ?? 0) > 0 && (
        <section className="mb-10">
          <p
            className="text-[10px] uppercase tracking-wide text-ink-faint mb-3"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            Venue data
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {ext.extraKpis!.map((kpi) => (
              <div
                key={kpi.label}
                className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col"
                style={{ minHeight: 88 }}
              >
                <p
                  className="text-[10px] text-ink-faint uppercase tracking-wide leading-snug"
                  style={{ fontFamily: "var(--font-mono, monospace)" }}
                >
                  {kpi.label}
                </p>
                <p className="mt-auto text-lg font-semibold tabular-nums leading-tight">
                  {kpi.value}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Historical charts */}
      {hasChart && (
        <section className="mb-10">
          <p
            className="text-[10px] uppercase tracking-wide text-ink-faint mb-4"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            Historical
          </p>
          <div
            className={`grid gap-6 ${ext.dailyVolumeChart && ext.dailyFeesChart ? "sm:grid-cols-2" : "grid-cols-1"}`}
          >
            {(ext.dailyVolumeChart?.length ?? 0) >= 3 && (
              <div className="card-soft rounded-lg p-4 border border-ink/15">
                <PerpBarChart
                  bars={ext.dailyVolumeChart!}
                  title="Daily Volume"
                  color="teal"
                />
              </div>
            )}
            {(ext.dailyFeesChart?.length ?? 0) >= 3 && (
              <div className="card-soft rounded-lg p-4 border border-ink/15">
                <PerpBarChart
                  bars={ext.dailyFeesChart!}
                  title="Daily Fees"
                  color="cyan"
                />
              </div>
            )}
          </div>
        </section>
      )}

      {/* All-time stats */}
      {hasAllTime && (
        <section className="mb-10">
          <p
            className="text-[10px] uppercase tracking-wide text-ink-faint mb-3"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            All-time
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {ext.totalVolumeUsd != null && (
              <StatCard label="Total Volume" value={fmtUSD(ext.totalVolumeUsd)} accent="teal" />
            )}
            {ext.totalFeesUsd != null && (
              <StatCard label="Total Fees" value={fmtUSD(ext.totalFeesUsd)} accent="cyan" />
            )}
            {ext.totalTradeCount != null && (
              <StatCard label="Total Trades" value={fmtCount(ext.totalTradeCount)} accent="indigo" />
            )}
          </div>
        </section>
      )}

      {/* Live benchmark results */}
      {rankings.length > 0 && (
        <section className="mb-10">
          {lastMeasured && (() => {
            const d = new Date(lastMeasured);
            return (
              <p className="mb-4 font-sans text-[11px] uppercase tracking-[0.18em] text-ink-muted">
                Last measured{" "}
                <time dateTime={d.toISOString()} className="text-ink-soft">
                  {d.toUTCString().replace("GMT", "UTC")}
                </time>
              </p>
            );
          })()}
          <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted mb-4">
            Live benchmark results
          </h2>
          <ol className="divide-y divide-rule border-y border-rule">
            {rankings.map((a) => {
              const value = a.hasData ? fmtUnit(a.p50, a.bench.unit) : null;
              return (
                <li key={a.benchSlug}>
                  <Link
                    href={`/benchmarks/${a.benchSlug}`}
                    className="group grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto] items-start sm:items-center gap-x-4 gap-y-2 py-5 pl-3 pr-3 hover:bg-paper-soft/60 transition-colors"
                  >
                    <span
                      className="font-sans tabular text-xl sm:text-2xl font-semibold w-12 text-center"
                      style={{ color: a.rank === 1 ? "var(--color-good)" : "var(--color-ink-soft)" }}
                    >
                      {a.hasData ? (
                        <>
                          #{a.rank}
                          <span className="block text-[9px] uppercase tracking-[0.16em] text-ink-faint mt-0.5">
                            of {a.totalRanked}
                          </span>
                        </>
                      ) : (
                        <span className="block text-[10px] uppercase tracking-[0.16em] text-ink-faint italic font-normal">
                          awaiting
                        </span>
                      )}
                    </span>
                    <div className="min-w-0">
                      <p
                        className="font-sans text-[10px] uppercase tracking-[0.18em] font-medium"
                        style={{ color: "var(--color-ink-faint)" }}
                      >
                        Trading
                      </p>
                      <h3 className="mt-0.5 display text-base sm:text-lg font-semibold leading-tight truncate">
                        {a.bench.title}
                      </h3>
                      <p className="text-xs text-ink-muted truncate">{a.bench.metric}</p>
                    </div>
                    <div className="col-start-2 sm:col-start-3 text-left sm:text-right">
                      {value ? (
                        <>
                          <p className="font-sans tabular text-base text-ink">{value}</p>
                          <p className="font-sans text-[9px] uppercase tracking-[0.16em] text-ink-faint mt-0.5 font-medium">
                            p50 · 24h
                          </p>
                        </>
                      ) : (
                        <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint italic font-medium">
                          data warming up
                        </p>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {/* Vault / Protocol */}
      {hasVault && (
        <section className="mb-10">
          <p
            className="text-[10px] uppercase tracking-wide text-ink-faint mb-3"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            Protocol
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {ext.vaultTvlUsd != null && (
              <StatCard label="Vault TVL" value={fmtUSD(ext.vaultTvlUsd)} accent="teal" />
            )}
            {ext.stakingAprPct != null && (
              <StatCard label="Staking APR" value={fmtPct(ext.stakingAprPct)} accent="cyan" />
            )}
          </div>

          {/* Collateral breakdown table */}
          {(ext.collateralBreakdown?.length ?? 0) > 0 && (
            <div className="mt-4 rounded-lg border border-rule overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-rule bg-paper-soft">
                    <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-wide text-ink-faint font-medium" style={{ fontFamily: "var(--font-mono, monospace)" }}>
                      Collateral
                    </th>
                    <th className="text-right px-4 py-2.5 text-[10px] uppercase tracking-wide text-ink-faint font-medium" style={{ fontFamily: "var(--font-mono, monospace)" }}>
                      TVL
                    </th>
                    <th className="text-right px-4 py-2.5 text-[10px] uppercase tracking-wide text-ink-faint font-medium" style={{ fontFamily: "var(--font-mono, monospace)" }}>
                      APR
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {ext.collateralBreakdown!.map((cr) => (
                    <tr key={cr.symbol} className="hover:bg-paper-soft/50 transition-colors">
                      <td className="px-4 py-3 font-medium">{cr.symbol}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-ink-soft">
                        {fmtUSD(cr.tvlUsd)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-good">
                        {fmtPct(cr.aprPct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Footer links */}
      <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-8 border-t border-rule text-[12px] text-ink-faint">
        <Link href="/perps" className="hover:text-ink underline underline-offset-2">
          Perp leaderboard
        </Link>
        <span aria-hidden>·</span>
        <Link
          href="/benchmarks/perp-fees"
          className="hover:text-ink underline underline-offset-2"
        >
          Perp fees bench
        </Link>
        <span aria-hidden>·</span>
        <Link
          href="/benchmarks/perp-funding"
          className="hover:text-ink underline underline-offset-2"
        >
          Funding bench
        </Link>
        <span aria-hidden>·</span>
        <a
          href={meta.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:text-ink underline underline-offset-2"
        >
          {externalHost}
          <ArrowUpRight size={11} strokeWidth={2} />
        </a>
      </footer>
    </article>
  );
}

function StatCard({
  label,
  value,
  accent = "teal",
}: {
  label: string;
  value: string;
  accent?: "teal" | "cyan" | "indigo";
}) {
  const dot =
    accent === "cyan"
      ? "#06b6d4"
      : accent === "indigo"
        ? "#6366f1"
        : "#14b8a6";
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col"
      style={{ minHeight: 88 }}
    >
      <div className="flex items-center justify-between gap-1 mb-1">
        <p
          className="text-[10px] text-ink-faint uppercase tracking-wide leading-snug"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {label}
        </p>
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: dot }}
          aria-hidden
        />
      </div>
      <p className="mt-auto text-lg sm:text-xl font-semibold tabular-nums leading-tight">
        {value}
      </p>
    </div>
  );
}
