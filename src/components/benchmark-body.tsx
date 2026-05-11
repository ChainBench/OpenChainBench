"use client";

import { useEffect, useState } from "react";
import type { Benchmark } from "@/types/benchmark";
import { ChainTabs } from "@/components/chain-tabs";
import { LedgerTable } from "@/components/ledger-table";
import { TimeSeriesChart } from "@/components/time-series-chart";
import { RankedBarChart } from "@/components/ranked-bar-chart";
import { RegionGrid } from "@/components/region-grid";
import { CountLeaderboard } from "@/components/count-leaderboard";
import { SectionLabel, SummaryStat } from "@/components/summary-stat";
import { fmtUnit, unitSuffix, fmtValue } from "@/lib/format";
import { computeFieldStats } from "@/lib/stats";
import type { ChainMeta } from "@/components/chain-tabs";

type ChainOption = { value: string; label: string };

function summarize(b: Benchmark | undefined): ChainMeta | null {
  if (!b) return null;
  const live = b.results.filter((r) => r.ms.p50 > 0);
  if (live.length === 0) return { providers: 0, metric: b.metric };
  const sorted = [...live].sort((a, c) =>
    b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50
  );
  return {
    providers: live.length,
    metric: b.metric,
    leader: {
      name: sorted[0].name,
      value: fmtUnit(sorted[0].ms.p50, b.unit),
    },
  };
}

/**
 * Client wrapper that renders the dynamic body of a bench detail page.
 * Receives every chain variant pre-fetched server-side, so flipping a
 * chain tab is a pure client state swap. No network round-trip, no RSC
 * payload, no Prom round-trip — instant.
 *
 * URL is kept in sync via `history.replaceState` so the active tab is
 * shareable, but we never trigger Next.js navigation (which would defeat
 * the whole point).
 */
export function BenchmarkBody({
  variants,
  options,
  initialChain,
}: {
  variants: Record<string, Benchmark>;
  options: ChainOption[];
  initialChain: string | null;
}) {
  const [chain, setChain] = useState<string | null>(initialChain);

  useEffect(() => {
    if (options.length === 0) return;
    const url = new URL(window.location.href);
    if (chain) url.searchParams.set("chain", chain);
    else url.searchParams.delete("chain");
    const next = url.pathname + (url.search ? url.search : "");
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, "", next);
    }
  }, [chain, options.length]);

  const benchmark = chain && variants[chain] ? variants[chain] : variants.__default;
  if (!benchmark) return null;

  const isDraft = benchmark.status === "draft";
  const { fieldMin, fieldMedian, fieldMax, tailMin, tailMax, tailSpread } =
    computeFieldStats(benchmark.results);

  return (
    <>
      {options.length > 0 && (
        <div className="mt-8">
          <ChainTabs
            options={options}
            selected={chain}
            onSelect={setChain}
            meta={Object.fromEntries(
              options
                .map((o) => [o.value, summarize(variants[o.value])])
                .filter(([, v]) => v !== null) as [string, ChainMeta][]
            )}
          />
        </div>
      )}

      {!isDraft && benchmark.unit === "count" && (
        <>
          <CountLeaderboard benchmark={benchmark} />
          <div className="mt-14">
            <SectionLabel>Provider ledger</SectionLabel>
            <LedgerTable benchmark={benchmark} />
          </div>
        </>
      )}

      {!isDraft && benchmark.unit !== "count" && (
        <>
          <dl className="mt-10 grid grid-cols-2 sm:flex sm:flex-wrap items-baseline gap-x-8 gap-y-3 border-y border-rule py-4">
            <SummaryStat
              label="Best"
              value={`${fmtValue(fieldMin, benchmark.unit)}${unitSuffix(benchmark.unit)}`}
            />
            <SummaryStat
              label="Median"
              value={`${fmtValue(fieldMedian, benchmark.unit)}${unitSuffix(benchmark.unit)}`}
            />
            <SummaryStat
              label="Worst"
              value={`${fmtValue(fieldMax, benchmark.unit)}${unitSuffix(benchmark.unit)}`}
            />
            <SummaryStat
              label="Spread"
              value={tailSpread > 0 ? `${tailSpread.toFixed(1)}×` : "—"}
              hint={
                tailSpread > 0
                  ? `${fmtUnit(tailMin, benchmark.unit)} → ${fmtUnit(tailMax, benchmark.unit)}`
                  : undefined
              }
            />
            <SummaryStat
              label="Samples · 24h"
              value={Math.round(benchmark.sampleSize).toLocaleString()}
              hint={`${benchmark.results.length} providers`}
            />
          </dl>

          <div className="mt-12">
            {benchmark.results.length >= 5 ||
            benchmark.unit === "bps" ||
            benchmark.unit === "pct" ? (
              <RankedBarChart benchmark={benchmark} />
            ) : (
              <TimeSeriesChart benchmark={benchmark} />
            )}
          </div>

          <div className="mt-14">
            <SectionLabel>Provider ledger · sorted by p50</SectionLabel>
            <LedgerTable benchmark={benchmark} />
          </div>

          {Object.keys(benchmark.extras.regions).length > 0 && (
            <div className="mt-14">
              <SectionLabel>By region</SectionLabel>
              <RegionGrid benchmark={benchmark} />
            </div>
          )}
        </>
      )}
    </>
  );
}
