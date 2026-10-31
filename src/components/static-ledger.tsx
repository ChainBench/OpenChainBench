import { Fragment } from "react";
/**
 * Server-rendered results table, used as the Suspense fallback around
 * BenchmarkBody. The interactive body is a client component that bails
 * out of static rendering (useSearchParams), so the served HTML of every
 * bench page carried a skeleton and no table: crawlers and answer engines
 * without JavaScript saw the H1, the TL;DR and the FAQ, and not one row of
 * the ranking they came to cite (audit 2026-09-19, round 2, blocker 2).
 * JavaScript clients swap this table for the interactive one on mount;
 * everything else keeps a real table.
 */
import { displayResults, isStaleBench } from "@/lib/provider-filters";
import { rankResults } from "@/lib/ranking";
import { fmtHeadline, fmtUnit } from "@/lib/format";
import { rowHref } from "@/lib/row-link";
import { rankedCandidates, rpcChainLabel } from "@/lib/citation";
import { countRows, nounFor, nounLabel } from "@/lib/row-noun";
import { valueColumnLabel, valueQualifier } from "@/lib/value-window";
import type { Benchmark } from "@/types/benchmark";
import { rateDecimals } from "@/lib/sample-precision";
import { panelsForStaticLedger } from "@/lib/static-panels";

export function StaticLedger({
  benchmark,
  regionCount,
}: {
  benchmark: Benchmark;
  /** Regions with data on this view, from the page's own
   *  declared-and-present filter. Omitted means no claim. */
  regionCount?: number;
}) {
  const rows = rankResults(displayResults(benchmark.results), benchmark.higherIsBetter);
  if (rows.length === 0) return null;
  const chain = rpcChainLabel(benchmark);
  const pausedOn = isStaleBench(benchmark) && benchmark.lastRunAt ? benchmark.lastRunAt.slice(0, 10) : null;
  const win = benchmark.window ?? "24h";
  // The TL;DR, the leader and /api/stat rank the 50 % floor cohort; the
  // table shows the 5 % floor cohort. Say both when they differ.
  const ranked = rankedCandidates(benchmark).length;
  // Rows the bench declines to rank must not be numbered as if it did.
  // This table is the Suspense fallback, so it is the only one a crawler
  // sees, and it numbered Phantom 1 at 160 bps while the TL;DR two blocks
  // above named FOMO the leader at 216. The interactive table sorts them
  // below with a Provisional hint after hydration; nothing did so before.
  const rankedSlugs = new Set(rankedCandidates(benchmark).map((r) => r.slug));
  const rankedRows = rows.filter((r) => rankedSlugs.has(r.slug));
  const provisionalRows = rows.filter((r) => !rankedSlugs.has(r.slug));
  const ordered = [...rankedRows, ...provisionalRows];
  // Rows outside the ranking are there for different reasons. A spec-declared
  // label ("On-chain DEX price", "RFQ or batch") names its own, and is printed
  // beside the row; only rows without one are below the sample floor. The
  // caption used to give the floor as the reason for every one of them, which
  // told crawlers that bench 305's on-chain feed lacked samples.
  const declaredReason = (r: (typeof rows)[number]) =>
    r.unrankedLabel && r.unrankedLabel !== "Provisional" ? r.unrankedLabel : null;
  const unrankedCaption = provisionalRows.some((r) => !declaredReason(r))
    ? "Measured, not ranked: sample below the ranking floor"
    : "Measured, not ranked";
  const rowNounOne = nounFor(benchmark, 1);
  const qualifier = valueQualifier(benchmark);
  // Metric panels are tabs in the interactive body, so the served HTML
  // carried the headline and nothing else: bench 273's origin split and
  // its two weekly columns existed for a reader and not for a crawler
  // (SEO audit 2026-09-23). They render here inside the same horizontal
  // scroller. WHICH of them, and why it is not simply the first three,
  // lives in panelsForStaticLedger with its own tests.
  const panels = panelsForStaticLedger(benchmark);
  // The region count comes from the page, which already worked out which
  // declared regions actually have data: the heading a crawler reads said
  // three on every bench, including those measured from fewer. Falls
  // back to no claim rather than to a number.
  const regionNote = regionCount && regionCount > 0 ? `, ${regionCount} region${regionCount === 1 ? "" : "s"}` : "";
  const heading = chain && pausedOn
    ? `Results: measurement paused since ${pausedOn}, last ranking of ${rows.length} free public ${chain} RPC endpoint${rows.length === 1 ? "" : "s"}`
    : chain && ranked < rows.length
    ? `Results: ${rows.length} free public ${chain} RPC endpoint${rows.length === 1 ? "" : "s"} measured, ${ranked} ranked by p50 latency (24h${regionNote})`
    : chain
    ? `Results: ${rows.length} free public ${chain} RPC endpoint${rows.length === 1 ? "" : "s"} ranked by p50 latency (24h${regionNote})`
    : ranked < rows.length
    ? `Results: ${countRows(benchmark, rows.length)} measured, ${ranked} ranked by ${benchmark.metric} (${qualifier})`
    : `Results: ${countRows(benchmark, rows.length)} ranked by ${benchmark.metric} (${qualifier})`;
  // A success rate is a claim about requests this bench sent. Benches that
  // send none set `ledger_reliability: false`, and the interactive table
  // honours it — but this fallback is what crawlers and no-JS readers get,
  // and it printed "Success 100.00%" for every row of bench 282, filled from
  // the default the loader uses when a spec declares no success query. The
  // spec's own comment says a success rate there "measures nothing".
  const showReliability = benchmark.ledgerReliability !== false;
  // The spec names its own value column, and the interactive table uses that
  // name. This fallback fell back to the generic one, so bench 282's crawler
  // view headed its money column "Value" where every reader of the real
  // table sees "Monthly bill". Only a column bound to the headline slot can
  // stand in for it.
  const valueHeading =
    benchmark.ledgerColumns?.find((c) => c.slot === "p50")?.label ??
    valueColumnLabel(benchmark);
  const showTail = benchmark.unit === "ms" || benchmark.unit === "s";
  return (
    <section className="mt-8" aria-labelledby="results">
      <h2 id="results" className="label-mono text-ink-faint mb-4">
        {heading}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            {benchmark.title}: {benchmark.metric} per {rowNounOne} ({qualifier}).
          </caption>
          <thead>
            <tr className="border-y-2 border-ink text-left">
              <th scope="col" className="py-2 pr-3">№</th>
              <th scope="col" className="py-2 pr-3">{nounLabel(benchmark)}</th>
              <th scope="col" className="py-2 px-3 text-right">{valueHeading}</th>
              {showTail && <th scope="col" className="py-2 px-3 text-right">p90</th>}
              {showTail && <th scope="col" className="py-2 px-3 text-right">p99</th>}
              {panels.map((p) => (
                <th key={p.id} scope="col" className="py-2 px-3 text-right">{p.label}</th>
              ))}
              {showReliability && (
                <th scope="col" className="py-2 pl-3 text-right">Success</th>
              )}
            </tr>
          </thead>
          <tbody>
            {ordered.map((r, i) => (
              <Fragment key={r.slug}>
                {i === rankedRows.length && provisionalRows.length > 0 ? (
                  <tr className="border-b border-ink/10">
                    <td colSpan={99} className="py-2 pr-3 text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                      {unrankedCaption}
                    </td>
                  </tr>
                ) : null}
              <tr className="border-b border-ink/10">
                <td className="py-2 pr-3 tabular-nums text-ink-faint">
                  {i < rankedRows.length ? i + 1 : <span className="sr-only">not ranked</span>}
                </td>
                <td className="py-2 pr-3 font-medium text-ink">
                  {/* Crawlable path from a ranking to the venue page: the
                      interactive ledger links on mount, this server-rendered
                      table did not, so bench HTML carried no /products link
                      (audit 2026-09-21). Same guard as the interactive row. */}
                  {/* Chain rows go to the chain hub, not to /products:
                      that route 404s for three of them, 308s for ten more
                      and declares /chains canonical for the rest. */}
                  {(() => {
                    const href = rowHref(benchmark, r);
                    return href === null ? (
                      r.name
                    ) : (
                      <a href={href} className="hover:underline underline-offset-2">
                        {r.name}
                      </a>
                    );
                  })()}
                  {r.priceReading && (
                    <span className="ml-2 text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                      {r.priceReading}
                    </span>
                  )}
                  {declaredReason(r) && (
                    <span className="ml-2 text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                      {declaredReason(r)}
                    </span>
                  )}
                  {/* The spec's per-provider qualifier. The interactive row
                      has shown it since the ledger existed (ledger-table.tsx)
                      and this table never did, so 1,710 tagged rows across
                      256 specs carried it for a reader and not for a crawler:
                      "On-chain DEX price", "RFQ or batch", and on bench 311
                      the plan each key is on, which is what separates a 0
                      (their product) from a blank (our access). */}
                  {r.tag && (
                    <span className="ml-2 text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                      {r.tag}
                    </span>
                  )}
                </td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtHeadline(r.ms.p50, benchmark, r.slug)}</td>
                {showTail && <td className="py-2 px-3 text-right tabular-nums text-ink-soft">{fmtUnit(r.ms.p90, benchmark.unit)}</td>}
                {showTail && <td className="py-2 px-3 text-right tabular-nums text-ink-soft">{fmtUnit(r.ms.p99, benchmark.unit)}</td>}
                {panels.map((p) => {
                  const v = p.values?.[r.slug];
                  return (
                    <td key={p.id} className="py-2 px-3 text-right tabular-nums text-ink-soft">
                      {v == null || !Number.isFinite(v) ? "—" : fmtUnit(v, p.unit ?? benchmark.unit)}
                    </td>
                  );
                })}
                {/* Same precision rule as the interactive table. This column
                    printed two decimals regardless of sample size, so
                    bridge-execution-latency served "100.00 %" on 17 to 27
                    executions, where a single failure moves the rate by 3.7 to
                    5.9 points. This is the table a crawler reads, so it was
                    the copy claiming the certainty. */}
                {showReliability && (
                  <td className="py-2 pl-3 text-right tabular-nums text-ink-soft">
                    {r.successRate.toFixed(rateDecimals(r.sampleSize))}%
                    {r.sampleSize != null && (
                      <span className="text-ink-faint"> (n={Math.round(r.sampleSize)})</span>
                    )}
                  </td>
                )}
              </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
