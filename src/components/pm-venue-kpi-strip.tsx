import type { PmVenueKpis } from "@/lib/pm-venue-data";

/**
 * Adaptive 6-card KPI strip for /prediction-markets venue sections.
 *
 * Card set depends on venue type:
 *   onchain  : Volume 30d / Open Interest / Active Markets / Median Resolution / p50 API / 24h Uptime
 *   offchain : Volume 30d / Active Markets / p50 API / 24h Uptime / Rate-limit headroom / Markets >$1m
 *
 * Cards with null data are skipped silently so the strip stays tidy on a
 * cold start. If every card is null the section calling us already hides
 * the strip.
 */

export type PmVenueType = "onchain" | "offchain";

type Card = { label: string; value: string; tip?: string };

export function PmVenueKpiStrip({
  kpis,
  venueType,
}: {
  kpis: PmVenueKpis;
  venueType: PmVenueType;
}) {
  const cards: Card[] = [];

  if (kpis.volume30d != null) {
    cards.push({
      label: "Volume 30d",
      value: fmtUSD(kpis.volume30d),
      tip: "USD notional traded over the rolling 30 day window.",
    });
  }

  if (venueType === "onchain" && kpis.openInterest != null) {
    cards.push({
      label: "Open Interest",
      value: fmtUSD(kpis.openInterest),
      tip: "USD value of outstanding positions on active markets.",
    });
  }

  if (kpis.activeMarkets != null) {
    cards.push({
      label: "Active markets",
      value: fmtCount(kpis.activeMarkets),
      tip: "Open markets accepting orders right now.",
    });
  }

  if (venueType === "onchain" && kpis.medianResolutionSec != null) {
    cards.push({
      label: "Median resolution",
      value: fmtDuration(kpis.medianResolutionSec),
      tip: "Median delay from market close to oracle settlement (bench 039).",
    });
  }

  if (kpis.apiP50Ms != null) {
    cards.push({
      label: "p50 API latency",
      value: fmtMs(kpis.apiP50Ms),
      tip: "Median public read endpoint latency, multi-region (bench 038).",
    });
  }

  if (kpis.uptime24h != null) {
    cards.push({
      label: "24h uptime",
      value: fmtPct(kpis.uptime24h),
      tip: "Successful health probes over the last 24h (bench 038).",
    });
  }

  if (venueType === "offchain") {
    if (kpis.rateLimitHeadroom != null) {
      cards.push({
        label: "Rate-limit headroom",
        value: fmtPct(kpis.rateLimitHeadroom),
        tip: "Fraction of the documented public rate-limit currently free (bench 037).",
      });
    }
    if (kpis.marketsAbove1m != null) {
      cards.push({
        label: "Markets > $1m",
        value: fmtCount(kpis.marketsAbove1m),
        tip: "Markets with 30d volume above $1m.",
      });
    }
  }

  if (cards.length === 0) return null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((c) => (
        <KpiCard key={c.label} card={c} />
      ))}
    </div>
  );
}

function KpiCard({ card }: { card: Card }) {
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col"
      title={card.tip}
      style={{ minHeight: 96 }}
    >
      <p
        className="label-mono text-[10px] text-ink-faint uppercase tracking-wide leading-snug"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {card.label}
      </p>
      <p className="mt-auto text-lg sm:text-xl font-semibold tabular-nums leading-tight">
        {card.value}
      </p>
    </div>
  );
}

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

function fmtCount(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return "0%";
  // Gauges that store percent in 0..1 vs already-in-percent are both
  // possible. Anything > 1 we assume is already a percent.
  const pct = v > 1.5 ? v : v * 100;
  if (pct >= 100) return "100%";
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

function fmtMs(v: number): string {
  if (!Number.isFinite(v)) return "0 ms";
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  if (v >= 100) return `${v.toFixed(0)} ms`;
  return `${v.toFixed(1)} ms`;
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "-";
  if (sec >= 86_400) return `${(sec / 86_400).toFixed(1)} d`;
  if (sec >= 3_600) return `${(sec / 3_600).toFixed(1)} h`;
  if (sec >= 60) return `${(sec / 60).toFixed(1)} min`;
  return `${sec.toFixed(0)} s`;
}
