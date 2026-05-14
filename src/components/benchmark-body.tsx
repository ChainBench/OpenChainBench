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

/** One labelled row of dimension tabs (Chain, Region, …). Reuses the
 *  existing ChainTabs visual so we keep one design vocabulary for filters. */
function DimensionRow({
  label,
  options,
  selected,
  onSelect,
  metaByValue,
}: {
  label: string;
  options: ChainOption[];
  selected: string | null;
  onSelect: (v: string) => void;
  metaByValue?: Record<string, ChainMeta>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint shrink-0 w-14">
        {label}
      </span>
      <ChainTabs
        options={options}
        selected={selected}
        onSelect={onSelect}
        meta={metaByValue}
      />
    </div>
  );
}

/** Mutate `url.searchParams` to keep one dimension param in sync.
 *  Removes the param when the value is the first option (the implicit
 *  default) so canonical URLs stay short. */
function syncParam(
  url: URL,
  key: string,
  value: string | null,
  options: ChainOption[],
) {
  const fallback = options[0]?.value ?? null;
  if (!options.length || !value || value === fallback) {
    url.searchParams.delete(key);
  } else {
    url.searchParams.set(key, value);
  }
}

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
/** Stable variant-map key mirroring `page.tsx:variantKey`. */
function variantKey(chain: string | null, region: string | null): string {
  return `${chain ?? "__none"}|${region ?? "__none"}`;
}

export function BenchmarkBody({
  variants,
  chainOptions,
  regionOptions,
  initialChain,
  initialRegion,
}: {
  variants: Record<string, Benchmark>;
  chainOptions: ChainOption[];
  regionOptions: ChainOption[];
  initialChain: string | null;
  initialRegion: string | null;
}) {
  const [chain, setChain] = useState<string | null>(initialChain);
  const [region, setRegion] = useState<string | null>(initialRegion);

  useEffect(() => {
    const url = new URL(window.location.href);
    syncParam(url, "chain", chain, chainOptions);
    syncParam(url, "region", region, regionOptions);
    const next = url.pathname + (url.search ? url.search : "");
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, "", next);
    }
  }, [chain, region, chainOptions, regionOptions]);

  const fallbackChain = chainOptions[0]?.value ?? null;
  const fallbackRegion = regionOptions[0]?.value ?? null;
  const effectiveChain = chainOptions.length > 0 ? (chain ?? fallbackChain) : null;
  const effectiveRegion = regionOptions.length > 0 ? (region ?? fallbackRegion) : null;
  const benchmark =
    variants[variantKey(effectiveChain, effectiveRegion)] ??
    variants[variantKey(null, null)] ??
    Object.values(variants)[0];
  if (!benchmark) return null;

  const isDraft = benchmark.status === "draft";
  const { fieldMin, fieldMedian, fieldMax, tailMin, tailMax, tailSpread } =
    computeFieldStats(benchmark.results);

  return (
    <>
      {(chainOptions.length > 0 || regionOptions.length > 0) && (
        <div className="mt-8 space-y-3">
          {chainOptions.length > 0 && (
            <DimensionRow
              label="Chain"
              options={chainOptions}
              selected={chain ?? fallbackChain}
              onSelect={setChain}
              metaByValue={Object.fromEntries(
                chainOptions
                  .map((o) => [
                    o.value,
                    summarize(variants[variantKey(o.value, effectiveRegion)]),
                  ])
                  .filter(([, v]) => v !== null) as [string, ChainMeta][]
              )}
            />
          )}
          {regionOptions.length > 0 && (
            <DimensionRow
              label="Region"
              options={regionOptions}
              selected={region ?? fallbackRegion}
              onSelect={setRegion}
              metaByValue={Object.fromEntries(
                regionOptions
                  .map((o) => [
                    o.value,
                    summarize(variants[variantKey(effectiveChain, o.value)]),
                  ])
                  .filter(([, v]) => v !== null) as [string, ChainMeta][]
              )}
            />
          )}
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
