import {
  feedIsMostlyWhole,
  feedNeedsDisclosure,
  hlDaySources,
} from "@/lib/hl-feed";
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
 * A third kind of day exists since 2026-10-15: one the node missed and cannot
 * replay, rebuilt from the export's own morning spliced to an afternoon
 * reassembled wallet by wallet from the info API. Rebuilding a day held in
 * full came out 0.43% under the node, against 31% short for the export alone.
 * Those days are reported on their own line and never folded into the node-day
 * count, because close is not measured and the whole point of this note is
 * that the reader can tell which they are reading.
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
  // A window holding reconstructions has to say so even when every day in it
  // is nominally whole, which is exactly when the truncation test goes quiet.
  // Saying nothing here would publish a reconstruction as a measurement, and
  // that is the single thing this note exists to prevent.
  const rebuilt = feed?.rebuiltDays ?? 0;
  // Negative, and 0 when the harness does not report it. 0 alongside rebuilt
  // days is treated as "not stated" rather than "no shortfall": a
  // reconstruction described as exact is the most flattering way to be wrong.
  const worstRebuilt = feed?.rebuiltWorstErrorPct ?? 0;
  const truncation = feedNeedsDisclosure(feed);
  if (!truncation && rebuilt === 0) return null;

  const mostlyWhole = feedIsMostlyWhole(feed);
  // Which source each day of the window came from. Until 2026-10-25 the
  // deployed harness carried no node code, so nodeDays was 0 and the only
  // honest lead was the export's. Both leads are kept: a node outage, or a
  // rollback to an older image, puts the page back in that state and the
  // note has to describe it correctly too.
  const src = feed ? hlDaySources(feed) : null;
  const nodeLead =
    feed && src && src.nodeDays > 0
      ? [
          `${src.nodeDays} of the last ${feed.windowDays} days are read from`,
          "our own Hyperliquid node, which publishes every hour of the day.",
          src.exportDays > 0
            ? [
                `${src.exportDays} ${src.exportDays === 1 ? "day is" : "days are"} left on Hyperliquid's`,
                "public per-builder export, which stopped before midnight UTC",
                feed.truncatedDaysWindow > 0
                  ? `on ${feed.truncatedDaysWindow} of the window's days`
                  : "on part of the window",
                "and sums such a day at roughly 43% of its real size.",
              ].join(" ")
            : "No day in the window rests on that export alone.",
        ].join(" ")
      : null;
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
        {!truncation
          ? "Some days are rebuilt, not measured"
          : mostlyWhole
            ? "A few days come from a partial upstream feed"
            : // A window the node supplies most of still earns the amber
              // tone while a tenth of it is reconstruction, but the label
              // may not hand the whole window to the upstream feed: on
              // 2026-10-25 that read "upstream feed is publishing partial
              // days" over a window with two such days in thirty.
              nodeLead
              ? "Part of this window is rebuilt or partial"
              : "Upstream feed is publishing partial days"}
      </p>
      {!truncation ? null : !feed ? (
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
            // The old sentence took the remainder as windowDays - nodeDays
            // and then said the truncated count was "of those", which the
            // gauges cannot support: a rebuilt day is in that remainder, and
            // truncatedDaysWindow counts every day the export cut short
            // including the ones the node replaced. On 2026-10-25 that read
            // "the remaining 12 fall back to the export, and 11 of those
            // stop around 12:10", where only 2 days rested on the export.
            nodeLead,
            "Window totals read a few per cent low as a result. Figures are",
            "published as measured rather than scaled to an estimate.",
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      ) : nodeLead ? (
        <p>
          {[
            nodeLead,
            feed.coverageHours > 0
              ? `The latest day carries ${feed.coverageHours.toFixed(1)} of 24 hours.`
              : "",
            "Figures are published as measured rather than scaled to an",
            "estimate.",
          ]
            .filter(Boolean)
            .join(" ")}
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
      {rebuilt > 0 && (
        <p className="mt-2">
          {[
            // "Of those" only has a referent when the paragraph above it
            // ended on the export's short days. Once the lead names node
            // days and export days separately, "those" points at the export
            // remainder, which is the one set the rebuilt days are not in.
            truncation && !nodeLead
              ? `${rebuilt} of those ${rebuilt === 1 ? "days is" : "days are"} rebuilt rather than measured:`
              : `${rebuilt} ${rebuilt === 1 ? "day in this window is" : "days in this window are"} rebuilt rather than measured:`,
            "the export's own hours up to its cutoff, spliced to an afternoon",
            "reassembled wallet by wallet from Hyperliquid's info API, for an",
            "outage our node cannot replay.",
            // The magnitude, not a reassurance. Rebuilding two days we did
            // hold in full gave -0.4% where the export's morning covered 69%
            // of the day and -28% where it covered 27%, so quoting the good
            // one as though it described all of them would be the flattering
            // half of a measurement presented as the whole of it.
            worstRebuilt < 0
              ? `Each reads low, by up to ${Math.abs(worstRebuilt).toFixed(0)}% for the weakest day in this window.`
              : "How far short they read is not reported on this run, so treat them as a floor.",
            "How close one lands follows how much of the day the export's",
            "morning covered: rebuilding two days we did hold in full gave",
            "0.4% under the node where the morning covered 69% of it, and 28%",
            "under where it covered 27%. The export alone was 31% and 73%",
            "short on those same two days.",
            "They remain a reconstruction and not a measurement, which is why",
            "they are counted separately here and never added to the node-day",
            "count.",
          ].join(" ")}
        </p>
      )}
    </aside>
  );
}
