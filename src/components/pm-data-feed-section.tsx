import Link from "next/link";
import { fetchPmDataFeedKpis } from "@/lib/pm-venue-data";
import {
  PmVenueBenchCards,
  type PmVenueBenchRow,
} from "@/components/pm-venue-bench-cards";

/**
 * Per-data-feed anchored section on /prediction-markets. Lighter than the
 * venue section: a 4-card KPI strip + the 1-2 PM benches that include this
 * provider. The hub uses this for Mobula / Codex / Polymarket-CLOB / etc.
 *
 * Special case: when `slug === "polymarket-clob"` the freshness numbers
 * would be tautological (it's the T0 reference everyone is measured
 * against). We render a "T0 reference" badge in place of the freshness
 * cards instead.
 */

export type PmDataFeedSectionProps = {
  slug: string;
  /** Display name, e.g. "Mobula", "Codex", "Polymarket CLOB". */
  name: string;
  /** Optional logo asset path under `/public`. */
  logoSrc?: string;
  /** Optional homepage URL. */
  externalUrl?: string;
  /** Per-bench rows for the 1-2 PM benches this feed participates in
   *  (data-freshness 032, api-latency 038 when relevant). */
  benchRows: PmVenueBenchRow[];
  /** Optional methodology page slug under /products. Defaults to slug. */
  methodologySlug?: string;
};

export async function PmDataFeedSection({
  slug,
  name,
  logoSrc,
  externalUrl,
  benchRows,
  methodologySlug,
}: PmDataFeedSectionProps) {
  const kpis = await fetchPmDataFeedKpis(slug);
  const productSlug = methodologySlug ?? slug;

  // Hide the entire deep-dive when nothing is actually measured. The
  // previous shape rendered a "Data feed not live yet for X" card plus
  // a "Not measured yet" bench row, which read as a half-broken page on
  // /products/<slug> for feeds whose probes have not landed. Reference
  // feeds (Polymarket CLOB T0) still render because their badge is the
  // payload.
  const measuredRows = benchRows.filter(
    (r) => r.value !== null && r.rank !== null,
  );
  if (!kpis && measuredRows.length === 0) return null;

  return (
    <section
      id={slug}
      className="scroll-mt-24 py-10 border-t border-ink/8 first:border-0"
    >
      <header className="flex items-center justify-between flex-wrap gap-3 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          {logoSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoSrc}
              alt={`${name} logo`}
              width={32}
              height={32}
              className="rounded-md border border-ink/10 bg-paper-soft/40"
            />
          )}
          <h2 className="text-2xl sm:text-3xl font-semibold display tracking-tight">
            {name}
          </h2>
          {kpis?.isReference && (
            <span
              className="label-mono text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-md text-white"
              style={{
                background: "linear-gradient(90deg, #14b8a6, #06b6d4)",
                fontFamily: "var(--font-mono, monospace)",
              }}
            >
              T0 reference
            </span>
          )}
        </div>
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-ink-faint hover:text-ink underline underline-offset-2"
          >
            {safeHost(externalUrl)}
          </a>
        )}
      </header>

      {kpis && (
        <div className="mb-6">
          <p
            className="label-mono text-[10px] text-ink-faint mb-3"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            Live KPIs
          </p>
          <DataFeedKpiStrip kpis={kpis} />
        </div>
      )}

      {measuredRows.length > 0 && (
        <div className="mb-6">
          <p
            className="label-mono text-[10px] text-ink-faint mb-3"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            OpenChainBench measurements
          </p>
          <PmVenueBenchCards rows={measuredRows} />
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-4 text-[12px] text-ink-faint pt-4 border-t border-ink/8">
        <Link
          href={`/products/${productSlug}`}
          className="hover:text-ink underline underline-offset-2"
        >
          {name} product page
        </Link>
        <span aria-hidden>·</span>
        <Link
          href="/benchmarks/prediction-market-data-freshness"
          className="hover:text-ink underline underline-offset-2"
        >
          Data-freshness methodology
        </Link>
      </footer>
    </section>
  );
}

function DataFeedKpiStrip({
  kpis,
}: {
  kpis: NonNullable<Awaited<ReturnType<typeof fetchPmDataFeedKpis>>>;
}) {
  type Card = { label: string; value: string; tip?: string };
  const cards: Card[] = [];

  if (kpis.isReference) {
    cards.push({
      label: "Freshness reference",
      value: "T0",
      tip: "Polymarket CLOB is the reference clock all other feeds are measured against.",
    });
  } else if (kpis.freshnessP50Ms != null) {
    cards.push({
      label: "p50 freshness vs T0",
      value: fmtMs(kpis.freshnessP50Ms),
      tip: "Median latency between Polymarket CLOB (T0) and this feed (bench 032).",
    });
  }

  if (!kpis.isReference && kpis.freshnessP99Ms != null) {
    cards.push({
      label: "p99 freshness",
      value: fmtMs(kpis.freshnessP99Ms),
      tip: "99th-percentile latency vs Polymarket CLOB.",
    });
  }

  if (kpis.uptime24h != null) {
    cards.push({
      label: "24h uptime",
      value: fmtPct(kpis.uptime24h),
      tip: "Successful health probes over the last 24h.",
    });
  }

  cards.push({
    label: "Coverage",
    value:
      kpis.venueCoverage.length > 0
        ? `${kpis.venueCoverage.length} venue${kpis.venueCoverage.length === 1 ? "" : "s"}`
        : "Coverage TBD",
    tip:
      kpis.venueCoverage.length > 0
        ? kpis.venueCoverage.join(", ")
        : "Venues this feed reports on once probed.",
  });

  if (cards.length === 0) return null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col"
          title={c.tip}
          style={{ minHeight: 96 }}
        >
          <p
            className="label-mono text-[10px] text-ink-faint uppercase tracking-wide leading-snug"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {c.label}
          </p>
          <p className="mt-auto text-lg sm:text-xl font-semibold tabular-nums leading-tight">
            {c.value}
          </p>
        </div>
      ))}
    </div>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function fmtMs(v: number): string {
  if (!Number.isFinite(v)) return "0 ms";
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  if (v >= 100) return `${v.toFixed(0)} ms`;
  return `${v.toFixed(1)} ms`;
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return "0%";
  const pct = v > 1.5 ? v : v * 100;
  if (pct >= 100) return "100%";
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}
