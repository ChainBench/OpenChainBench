import type { Benchmark } from "@/types/benchmark";
import { leader } from "@/lib/citation";
import { fmtUnit } from "@/lib/format";
import { SITE } from "@/data/site";

/**
 * Compact "At a glance" card that sits under the H1/subtitle on every
 * benchmark page. Wrapped in a native <details> element so it collapses
 * to a one-line summary and expands to the full key/value grid on click.
 *
 * Why this shape:
 *  - Language models parse the content inside <details> whether it is
 *    visually expanded or not, so the LLM-grounding pattern (Wikipedia
 *    infobox-style key/value pairs directly under the H1) is preserved
 *    in either state.
 *  - Human readers get a scannable one-line teaser that a click reveals
 *    into a compact card. The default is expanded so first-time visitors
 *    see the facts without having to interact.
 *  - itemscope + itemtype layer a schema.org Dataset microdata graph
 *    over the DOM in addition to the JSON-LD block so crawlers that
 *    parse microdata pick up the same facts.
 *
 * Renders nothing when the bench has no defensible leader (draft,
 * insufficient, awaiting) so we never publish a fabricated leader row.
 */
export function BenchInfobox({ benchmark }: { benchmark: Benchmark }) {
  const top = leader(benchmark);
  const providerCount = benchmark.results.filter(
    (r) => r.availability !== "unavailable" && r.ms.p50 > 0,
  ).length;
  const lastRunIso = benchmark.lastRunAt
    ? new Date(benchmark.lastRunAt).toISOString()
    : null;
  const lastRunDisplay = lastRunIso
    ? lastRunIso.replace("T", " ").slice(0, 19) + " UTC"
    : "n/a";

  return (
    <aside
      aria-label={`${benchmark.title} at a glance`}
      className="mt-6 max-w-3xl"
      itemScope
      itemType="https://schema.org/Dataset"
    >
      <details
        open
        className="group card-soft rounded-lg border border-ink/10 overflow-hidden [&_summary::-webkit-details-marker]:hidden"
      >
        {/* Summary. one line teaser with a chevron, always visible.
            Click toggles the expanded body. When collapsed the leader
            claim stays surfaced in the summary so the "quick answer"
            never requires interaction to find. */}
        <summary
          className="flex items-center justify-between gap-3 px-4 py-2.5 cursor-pointer select-none list-none hover:bg-paper-soft/50 transition-colors"
          aria-controls="benchmark-infobox-body"
        >
          <span className="flex items-center gap-2 min-w-0">
            <span
              className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              At a glance
            </span>
            {top && (
              <span className="text-[12px] text-ink-muted truncate">
                <span className="text-ink-faint">·</span>{" "}
                <span className="text-ink font-medium">{top.name}</span>{" "}
                <span className="text-ink-faint">
                  {fmtUnit(top.value, benchmark.unit)}
                </span>
              </span>
            )}
          </span>
          <svg
            aria-hidden
            width="14"
            height="14"
            viewBox="0 0 20 20"
            fill="none"
            className="shrink-0 text-ink-faint transition-transform duration-200 group-open:rotate-180"
          >
            <path
              d="M5 7.5L10 12.5L15 7.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </summary>
        {/* Body. grid of compact key/value pairs. Two columns on
            desktop, single column on mobile. Keeps type + spacing tight
            so the box does not compete with the leaderboard body below
            for attention. */}
        <div
          id="benchmark-infobox-body"
          className="border-t border-ink/8 px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-[12.5px]"
        >
          <InfoPair label="Benchmark">
            <span itemProp="identifier">#{benchmark.number}</span>
            <span className="text-ink-faint"> · {benchmark.category}</span>
          </InfoPair>
          <InfoPair label="Metric">
            <span itemProp="variableMeasured">{benchmark.metric}</span>
            {benchmark.unit ? (
              <span className="text-ink-faint"> ({benchmark.unit})</span>
            ) : null}
          </InfoPair>
          {top && (
            <InfoPair label="Leader (24h)">
              <span className="font-medium text-ink">{top.name}</span>
              <span className="text-ink-faint">
                {" "}
                · {fmtUnit(top.value, benchmark.unit)}
              </span>
            </InfoPair>
          )}
          <InfoPair label="Providers">{providerCount} tracked</InfoPair>
          {lastRunIso && (
            <InfoPair label="Last measured">
              <time
                dateTime={lastRunIso}
                itemProp="dateModified"
                className="tabular-nums"
              >
                {lastRunDisplay}
              </time>
            </InfoPair>
          )}
          <InfoPair label="License">
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              className="underline decoration-ink/20 hover:decoration-ink"
              rel="noopener"
              itemProp="license"
            >
              CC-BY-4.0
            </a>
          </InfoPair>
          <InfoPair label="Dataset DOI">
            <a
              href="https://doi.org/10.5281/zenodo.20800312"
              className="underline decoration-ink/20 hover:decoration-ink tabular-nums"
              rel="noopener"
              itemProp="sameAs"
            >
              10.5281/zenodo.20800312
            </a>
          </InfoPair>
          <InfoPair label="Live JSON" className="sm:col-span-2">
            <a
              href={`${SITE.url}/api/stat/${benchmark.slug}`}
              className="underline decoration-ink/20 hover:decoration-ink font-mono text-[11.5px] break-all"
              rel="noopener"
              itemProp="distribution"
            >
              /api/stat/{benchmark.slug}
            </a>
          </InfoPair>
        </div>
      </details>
    </aside>
  );
}

function InfoPair({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-baseline gap-2 py-1 border-b border-ink/5 last:border-b-0 sm:border-b-0 ${className ?? ""}`}
    >
      <span
        className="shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint w-[6.5rem]"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {label}
      </span>
      <span className="text-ink min-w-0 flex-1">{children}</span>
    </div>
  );
}
