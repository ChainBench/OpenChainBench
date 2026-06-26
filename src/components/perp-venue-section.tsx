import Link from "next/link";
import { loadAlternativeSlugs } from "@/lib/alternatives";
import { fetchPerpVenueKpis } from "@/lib/perp-venue-data";
import { PerpVenueKpiStrip } from "@/components/perp-venue-kpi-strip";
import {
  PerpVenueBenchCards,
  type PerpVenueBenchRow,
} from "@/components/perp-venue-bench-cards";

/**
 * Per-venue anchored section, wired into /products/<slug> alongside
 * the HL builder dashboard and PM venue section. URL anchor is the
 * venue slug, so `?#hyperliquid` jumps straight to this section.
 *
 * Composition top to bottom:
 *   1. Heading + chain badge + external link
 *   2. KPI strip (6 adaptive cards)
 *   3. Bench cards row (perp-fees + perp-funding)
 *   4. Footer cross-links: /products/<slug>, /alternatives/<slug>, external,
 *      plus an extra Hyperliquid deep-dive pointer when slug is hyperliquid
 *
 * Hide-if-empty: when the KPI feed returns null AND no bench row has a
 * measured value, the section returns null (same lesson PM learned in
 * PR #660). Keeps half-broken venue pages off the index.
 *
 * Server component. Per-venue Prom fetch is cached via unstable_cache
 * inside the data module, so cold renders stay under the page-level ISR
 * budget.
 */

export type PerpVenueSectionProps = {
  slug: string;
  /** Human-readable name shown in the heading. */
  name: string;
  /** Chain badge label, e.g. "Hyperliquid L1", "Arbitrum". */
  chainLabel: string;
  /** External site URL, e.g. "https://hyperliquid.xyz". */
  externalUrl: string;
  /** Cohort slug for the bench rows (gmx-v2 for the GMX entry). */
  cohortSlug: string;
  /** Per-bench cohort rows produced by the parent context (already
   *  warm in the same fetchPerpCohort cache as the hub). */
  benchRows: PerpVenueBenchRow[];
};

export async function PerpVenueSection({
  slug,
  name,
  chainLabel,
  externalUrl,
  cohortSlug,
  benchRows,
}: PerpVenueSectionProps) {
  const [kpis, altSlugs] = await Promise.all([
    fetchPerpVenueKpis(cohortSlug),
    loadAlternativeSlugs(),
  ]);
  const externalHost = safeHost(externalUrl);
  // Only emit /alternatives/<slug> when the YAML actually exists for
  // this venue. Most perp cohort venues (lighter, vertex, grvt, ostium,
  // variational, pacifica, aevo, edgex, paradex, extended, aster, ...)
  // ship without an alternatives page and the hardcoded link was
  // leaking 404s into Google's crawl from /products/<slug>.
  const hasAlternativesPage = altSlugs.includes(slug);

  const measured = benchRows.filter(
    (r) => r.value !== null && r.rank !== null,
  );

  // Hide-if-empty: no KPI feed AND no measured bench row means there
  // is nothing useful to render on this venue. Return null so the
  // product page stays clean (same pattern as PmDataFeedSection).
  if (!kpis && measured.length === 0) return null;

  return (
    <section
      id={slug}
      className="scroll-mt-24 py-10 border-t border-ink/8 first:border-0"
    >
      <header className="flex items-center justify-between flex-wrap gap-3 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-2xl sm:text-3xl font-semibold display tracking-tight">
            {name}
          </h2>
          <span
            className="label-mono text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-md border border-ink/15 text-ink-faint"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {chainLabel}
          </span>
        </div>
        <a
          href={externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-ink-faint hover:text-ink underline underline-offset-2"
        >
          Open {externalHost}
        </a>
      </header>

      {kpis && (
        <div className="mb-6">
          <p
            className="label-mono text-[10px] text-ink-faint mb-3"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            Live KPIs
          </p>
          <PerpVenueKpiStrip kpis={kpis} />
        </div>
      )}

      {measured.length > 0 && (
        <div className="mb-6">
          <p
            className="label-mono text-[10px] text-ink-faint mb-3"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            OpenChainBench measurements
          </p>
          <PerpVenueBenchCards rows={measured} />
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-4 text-[12px] text-ink-faint pt-4 border-t border-ink/8">
        <Link
          href={`/perps`}
          className="hover:text-ink underline underline-offset-2"
        >
          All perp venues
        </Link>
        <span aria-hidden>·</span>
        {hasAlternativesPage && (
          <>
            <Link
              href={`/alternatives/${slug}`}
              className="hover:text-ink underline underline-offset-2"
            >
              {name} alternatives
            </Link>
            <span aria-hidden>·</span>
          </>
        )}
        <a
          href={externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-ink underline underline-offset-2"
        >
          View on {externalHost}
        </a>
        {slug === "hyperliquid" && (
          <>
            <span aria-hidden>·</span>
            <Link
              href="/hyperliquid"
              className="hover:text-ink underline underline-offset-2"
            >
              Hyperliquid deep-dive on /hyperliquid
            </Link>
          </>
        )}
      </footer>
    </section>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
