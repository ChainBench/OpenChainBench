import { feedNeedsDisclosure } from "@/lib/hl-feed";
import type { HlFeedCoverage } from "@/lib/hl-feed";

/**
 * Says how much of each day Hyperliquid's public per-builder export actually
 * carried, whenever that is less than all of it.
 *
 * Every figure on these pages is a sum over UTC days read from that export.
 * It cuts days off at roughly 12:10 UTC, intermittently since 2026-09-08 and
 * on all but one day since 2026-09-22, and on the days it did carry in full,
 * the hours before 13:00 hold about 43% of the notional and 44% of the fees.
 * So a 30d total built from a window more than half made of those days lands
 * near half of what a tracker reading a complete feed reports, and nothing on
 * the page said so.
 *
 * The figures stay as measured rather than scaled up to a guess. What changes
 * is that the reader is told what the denominator is, which is the difference
 * between an incomplete measurement and a wrong one.
 */
export function HlFeedCoverageNote({
  feed,
  className = "",
}: {
  feed: HlFeedCoverage | null;
  className?: string;
}) {
  if (!feedNeedsDisclosure(feed)) return null;

  const hours =
    feed && feed.coverageHours > 0 ? feed.coverageHours.toFixed(1) : null;

  return (
    <aside
      className={
        "rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-[12.5px] leading-relaxed text-ink-soft " +
        className
      }
    >
      <p className="label-mono text-[10px] text-amber-700 dark:text-amber-400 mb-1.5">
        Upstream feed is publishing partial days
      </p>
      {feed ? (
        <p>
          {feed.daysMeasured > 0 ? (
            <>
              {feed.truncatedDaysWindow} of the {feed.daysMeasured} days
              measured
            </>
          ) : (
            <>
              {feed.truncatedDaysWindow} days in the last {feed.windowDays}
            </>
          )}{" "}
          in Hyperliquid&apos;s public per-builder export stop before midnight
          UTC
          {hours ? <>, and the latest day carries {hours} of 24 hours</> : null}
          . Every window figure below is a sum over a {feed.windowDays}-day
          window made partly of those days, so revenue, volume and the feed-day
          column read low. On the days the export did carry in full, the hours
          before 13:00 UTC hold roughly 43% of the notional, which is the size
          of the shortfall on each short day. Figures are published as measured
          rather than scaled to an estimate, and rankings are affected only
          where two builders trade at different hours.
        </p>
      ) : (
        <p>
          Coverage of Hyperliquid&apos;s public per-builder export is not being
          measured on this run, so how much of each UTC day the figures below
          cover is unknown. The export has been publishing days cut off
          around 12:10 UTC on all but one day since 2026-09-22, which halves a
          window sum, so treat the figures as a floor until coverage reports
          again.
        </p>
      )}
    </aside>
  );
}
