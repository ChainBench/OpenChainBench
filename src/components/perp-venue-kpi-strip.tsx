import type { PerpVenueKpis } from "@/lib/perp-venue-data";

/**
 * Adaptive 6-card KPI strip for /perps venue sections.
 *
 * Card set:
 *   Volume 30d / Open Interest / Fees 30d /
 *   All-in fee 10x ETH (bps) / Funding 24h ETH (bps) / Tradable markets
 *
 * Cards with null data are skipped silently so the strip stays tidy on
 * a cold start. If every card is null, callers (PerpVenueSection) hide
 * the strip altogether.
 */

type Card = { label: string; value: string; tip?: string };

export function PerpVenueKpiStrip({ kpis }: { kpis: PerpVenueKpis }) {
  const cards: Card[] = [];

  if (kpis.volume30d != null) {
    cards.push({
      label: "Volume 30d",
      value: fmtUSD(kpis.volume30d),
      tip: "USD notional traded over the rolling 30 day window.",
    });
  }

  if (kpis.openInterest != null) {
    cards.push({
      label: "Open Interest",
      value: fmtUSD(kpis.openInterest),
      tip: "USD value of outstanding positions on active markets.",
    });
  }

  if (kpis.fees30d != null) {
    cards.push({
      label: "Fees 30d",
      value: fmtUSD(kpis.fees30d),
      tip: "USD fees collected by the venue over the rolling 30 day window.",
    });
  }

  if (kpis.allInFeeBpsEth != null) {
    cards.push({
      label: "All-in fee (ETH 10x)",
      value: fmtBps(kpis.allInFeeBpsEth),
      tip: "Taker fee plus half-spread plus impact on a $1000 ETH 10x long, 24h average (bench perp-fees).",
    });
  }

  if (kpis.funding24hBpsEth != null) {
    cards.push({
      label: "Funding 24h (ETH)",
      value: fmtBpsSigned(kpis.funding24hBpsEth),
      tip: "Normalized funding cost to hold an ETH long for 24 hours, 24h average. Negative means longs get paid (bench perp-funding).",
    });
  }

  if (kpis.activeMarkets != null) {
    cards.push({
      label: "Tradable markets",
      value: fmtCount(kpis.activeMarkets),
      tip: "Markets currently listed and accepting orders.",
    });
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

function fmtBps(v: number): string {
  if (!Number.isFinite(v)) return "0 bps";
  if (Math.abs(v) >= 100) return `${v.toFixed(0)} bps`;
  return `${v.toFixed(1)} bps`;
}

function fmtBpsSigned(v: number): string {
  if (!Number.isFinite(v)) return "0 bps";
  const sign = v > 0 ? "+" : "";
  if (Math.abs(v) >= 100) return `${sign}${v.toFixed(0)} bps`;
  return `${sign}${v.toFixed(1)} bps`;
}
