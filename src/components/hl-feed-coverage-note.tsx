import { feedIsMostlyWhole, feedNeedsDisclosure } from "@/lib/hl-feed";
import type { HlFeedCoverage } from "@/lib/hl-feed";

/**
 * Says where the days behind these figures came from, and how much of each
 * one was actually published.
 *
 * Every figure on these pages is a sum over UTC days. Two sources supply
 * them. Our own Hyperliquid node writes every hour of every day it is up, so
 * a day from there is whole. Hyperliquid's public per-builder export cuts
 * most days off at roughly 12:10 UTC, and on the days it does carry in full,
 * the hours before 13:00 hold only about 43% of the notional: a day from
 * there is closer to a third than a half of itself.
 *
 * The note therefore has two voices. A window built from the export is a
 * warning, because its totals read near half of what a full-feed tracker
 * reports. A window that is almost all node days is a footnote naming the
 * few days the node was down, which cost a few per cent. The figures are
 * published as measured in both cases, never scaled to an estimate; what
 * changes is how loudly the reader is told what the denominator is.
 */
export function HlFeedCoverageNote({
  feed,
  className = "",
}: {
  feed: HlFeedCoverage | null;
  className?: string;
}) {
  if (!feedNeedsDisclosure(feed)) return null;

  const mostlyWhole = feedIsMostlyWhole(feed);
  const tone = mostlyWhole
    ? "border-ink/15 bg-paper-soft/40 text-ink-soft"
    : "border-amber-500/30 bg-amber-500/5 text-ink-soft";
  const labelTone = mostlyWhole
    ? "text-ink-faint"
    : "text-amber-700 dark:text-amber-400";

  return (
    <aside
      className={`rounded-lg border p-4 text-[12.5px] leading-relaxed ${tone} ${className}`}
    >
      <p className={`label-mono text-[10px] mb-1.5 ${labelTone}`}>
        {mostlyWhole
          ? "A few days come from a partial upstream feed"
          : "Upstream feed is publishing partial days"}
      </p>
      {!feed ? (
        <p>
          Coverage is not being measured on this run, so how much of each UTC
          day the figures below cover is unknown. Hyperliquid&apos;s public
          per-builder export has been publishing days cut off around 12:10 UTC
          on all but one day since 2026-09-22, so treat the figures as a floor
          until coverage reports again.
        </p>
      ) : mostlyWhole ? (
        <p>
          {/* The sentence is assembled as one string rather than woven
              through JSX: a space that sits between an expression and the
              text after it is trimmed by the transform, which is how this
              first shipped reading "The remaining 4fall back to". */}
          {[
            `${feed.nodeDays} of the last ${feed.windowDays} days are read from`,
            "our own Hyperliquid node, which publishes every hour of the day.",
            `The remaining ${feed.windowDays - feed.nodeDays} fall back to`,
            "Hyperliquid's public per-builder export because the node was down",
            "for part of them, and",
            feed.truncatedDaysWindow > 0
              ? `${feed.truncatedDaysWindow} of those stop around 12:10 UTC.`
              : "some of those stop before midnight UTC.",
            "Those days are summed at roughly 43% of their real size, so the",
            "window totals read a few per cent low. Figures are published as",
            "measured rather than scaled to an estimate.",
          ].join(" ")}
        </p>
      ) : (
        <p>
          {[
            feed.daysMeasured > 0
              ? `${feed.truncatedDaysWindow} of the ${feed.daysMeasured} days measured`
              : `${feed.truncatedDaysWindow} days in the last ${feed.windowDays}`,
            "in Hyperliquid's public per-builder export stop before midnight UTC",
            feed.coverageHours > 0
              ? `, and the latest day carries ${feed.coverageHours.toFixed(1)} of 24 hours.`
              : ".",
            `Every window figure below is a sum over a ${feed.windowDays}-day`,
            "window made partly of those days, so revenue, volume and the",
            "feed-day column read low. On the days the export did carry in",
            "full, the hours before 13:00 UTC hold roughly 43% of the notional,",
            "which is the size of the shortfall on each short day. Figures are",
            "published as measured rather than scaled to an estimate.",
          ]
            .join(" ")
            .replace(" , ", ", ")
            .replace(" . ", ". ")}
        </p>
      )}
    </aside>
  );
}
