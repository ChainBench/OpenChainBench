import Link from "next/link";

type Props = {
  /** Optional YYYY-MM-DD review date. When present, appears as a dated
   *  <time> element so answer-engine crawlers pick up the review recency
   *  alongside the byline (matches Google's E-E-A-T freshness signal). */
  reviewed?: string;
};

/**
 * Named-maintainer byline. Rendered under editorial prose blocks (currently
 * the answers page "Editorial context" block) so the accountable human is
 * visible to readers, not only to structured-data crawlers. The link points
 * at /team, which is the same URL Person.mainEntityOfPage anchors sitewide,
 * so on-page anchor + JSON-LD @id resolve to the same document.
 *
 * Neutral typography, uppercase tracked label pattern matching the rest of
 * the site's small-caps metadata rows (see label-mono, tracking-[0.16em]).
 */
export function Byline({ reviewed }: Props) {
  return (
    <p className="mt-3 font-sans text-[11px] uppercase tracking-[0.16em] text-ink-muted font-medium">
      By{" "}
      <Link href="/team" className="text-ink hover:underline underline-offset-2">
        Florent Tapponnier
      </Link>
      {reviewed ? (
        <>
          {", reviewed "}
          <time dateTime={reviewed} className="tabular normal-case tracking-normal text-ink-soft">
            {reviewed}
          </time>
        </>
      ) : null}
    </p>
  );
}
