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
import { fmtUnit } from "@/lib/format";
import { rowHref } from "@/lib/row-link";
import { rankedCandidates, rpcChainLabel } from "@/lib/citation";
import { countRows, nounFor, nounLabel } from "@/lib/row-noun";
import { valueColumnLabel, valueQualifier } from "@/lib/value-window";
import type { Benchmark } from "@/types/benchmark";

/** How many metric panels the server table carries. Three keeps the row
 *  readable at phone width next to the rank, name, headline and success
 *  columns; a bench with ten panels (perp-pf-ratio) would otherwise ship a
 *  table nobody can scan. The rest stay in the interactive tabs. */
const MAX_STATIC_PANELS = 3;

export function StaticLedger({ benchmark }: { benchmark: Benchmark }) {
  const rows = rankResults(displayResults(benchmark.results), benchmark.higherIsBetter);
  if (rows.length === 0) return null;
  const chain = rpcChainLabel(benchmark);
  const pausedOn = isStaleBench(benchmark) && benchmark.lastRunAt ? benchmark.lastRunAt.slice(0, 10) : null;
  const win = benchmark.window ?? "24h";
  // The TL;DR, the leader and /api/stat rank the 50 % floor cohort; the
  // table shows the 5 % floor cohort. Say both when they differ.
  const ranked = rankedCandidates(benchmark).length;
  const rowNounOne = nounFor(benchmark, 1);
  const qualifier = valueQualifier(benchmark);
  // Metric panels are tabs in the interactive body, so the served HTML
  // carried the headline and nothing else: bench 273's origin split and
  // its two weekly columns existed for a reader and not for a crawler
  // (SEO audit 2026-09-23). Render the first few here, inside the same
  // horizontal scroller, so the table stays readable on a phone.
  const panels = (benchmark.metricPanels ?? [])
    .filter((p) => p.values && Object.keys(p.values).length > 0)
    .slice(0, MAX_STATIC_PANELS);
  const heading = chain && pausedOn
    ? `Results: measurement paused since ${pausedOn}, last ranking of ${rows.length} free public ${chain} RPC endpoint${rows.length === 1 ? "" : "s"}`
    : chain && ranked < rows.length
    ? `Results: ${rows.length} free public ${chain} RPC endpoint${rows.length === 1 ? "" : "s"} measured, ${ranked} ranked by p50 latency (24h, 3 regions)`
    : chain
    ? `Results: ${rows.length} free public ${chain} RPC endpoint${rows.length === 1 ? "" : "s"} ranked by p50 latency (24h, 3 regions)`
    : ranked < rows.length
    ? `Results: ${countRows(benchmark, rows.length)} measured, ${ranked} ranked by ${benchmark.metric} (${qualifier})`
    : `Results: ${countRows(benchmark, rows.length)} ranked by ${benchmark.metric} (${qualifier})`;
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
              <th scope="col" className="py-2 px-3 text-right">{valueColumnLabel(benchmark)}</th>
              {showTail && <th scope="col" className="py-2 px-3 text-right">p90</th>}
              {showTail && <th scope="col" className="py-2 px-3 text-right">p99</th>}
              {panels.map((p) => (
                <th key={p.id} scope="col" className="py-2 px-3 text-right">{p.label}</th>
              ))}
              <th scope="col" className="py-2 pl-3 text-right">Success</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.slug} className="border-b border-ink/10">
                <td className="py-2 pr-3 tabular-nums text-ink-faint">{i + 1}</td>
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
                </td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtUnit(r.ms.p50, benchmark.unit)}</td>
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
                <td className="py-2 pl-3 text-right tabular-nums text-ink-soft">{r.successRate.toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
