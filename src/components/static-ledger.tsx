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
import { rpcChainLabel } from "@/lib/citation";
import type { Benchmark } from "@/types/benchmark";

export function StaticLedger({ benchmark }: { benchmark: Benchmark }) {
  const rows = rankResults(displayResults(benchmark.results), benchmark.higherIsBetter);
  if (rows.length === 0) return null;
  const chain = rpcChainLabel(benchmark);
  const pausedOn = isStaleBench(benchmark) && benchmark.lastRunAt ? benchmark.lastRunAt.slice(0, 10) : null;
  const win = benchmark.window ?? "24h";
  const heading = chain && pausedOn
    ? `Results: measurement paused since ${pausedOn}, last ranking of ${rows.length} free public ${chain} RPC endpoint${rows.length === 1 ? "" : "s"}`
    : chain
    ? `Results: ${rows.length} free public ${chain} RPC endpoint${rows.length === 1 ? "" : "s"} ranked by p50 latency (24h, 3 regions)`
    : `Results: ${rows.length} providers ranked by ${benchmark.metric} (p50, ${win})`;
  const showTail = benchmark.unit === "ms" || benchmark.unit === "s";
  return (
    <section className="mt-8" aria-labelledby="results">
      <h2 id="results" className="label-mono text-ink-faint mb-4">
        {heading}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            {benchmark.title}: {benchmark.metric} per provider, last {win === "24h" ? "24 hours" : win}.
          </caption>
          <thead>
            <tr className="border-y-2 border-ink text-left">
              <th scope="col" className="py-2 pr-3">№</th>
              <th scope="col" className="py-2 pr-3">Provider</th>
              <th scope="col" className="py-2 px-3 text-right">p50</th>
              {showTail && <th scope="col" className="py-2 px-3 text-right">p90</th>}
              {showTail && <th scope="col" className="py-2 px-3 text-right">p99</th>}
              <th scope="col" className="py-2 pl-3 text-right">Success</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.slug} className="border-b border-ink/10">
                <td className="py-2 pr-3 tabular-nums text-ink-faint">{i + 1}</td>
                <td className="py-2 pr-3 font-medium text-ink">{r.name}</td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtUnit(r.ms.p50, benchmark.unit)}</td>
                {showTail && <td className="py-2 px-3 text-right tabular-nums text-ink-soft">{fmtUnit(r.ms.p90, benchmark.unit)}</td>}
                {showTail && <td className="py-2 px-3 text-right tabular-nums text-ink-soft">{fmtUnit(r.ms.p99, benchmark.unit)}</td>}
                <td className="py-2 pl-3 text-right tabular-nums text-ink-soft">{r.successRate.toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
