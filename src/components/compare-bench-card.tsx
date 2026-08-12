"use client";

import { Fragment } from "react";
import Link from "next/link";
import type { Benchmark } from "@/types/benchmark";
import { fmtUnit, fmtValue, unitSuffix } from "@/lib/format";

type Panel = {
  rank: number;
  p50: number;
  p99: number;
  sampleSize?: number;
};

type BreakdownRow = {
  value: string;
  label: string;
  aP50: number;
  bP50: number;
  aWins: boolean;
  bWins: boolean;
};

type ChainRegionEntry = BreakdownRow & {
  regionRows: BreakdownRow[];
};

export type PanelScope = {
  id: string;
  label: string;
  unit: Benchmark["unit"];
  higherIsBetter: boolean;
  aValue: number;
  bValue: number;
  /** When true, don't apply win/lose coloring — size/scale metric, not quality. */
  neutral?: boolean;
};

export type CompareBench = {
  slug: string;
  title: string;
  category: Benchmark["category"];
  unit: Benchmark["unit"];
  metric: string;
  higherIsBetter: boolean;
  lastRunAt: Benchmark["lastRunAt"];
  aResult: Panel;
  bResult: Panel;
  aggregateWinner: "a" | "b" | "tie";
  chainBreakdown: BreakdownRow[];
  regionBreakdown: BreakdownRow[];
  chainRegionMatrix: ChainRegionEntry[];
  panelScopes: PanelScope[];
  /** Optional in-panel note shown below the metric cards (e.g. scope clarification). */
  note?: string;
};

function decideWinner(
  aVal: number,
  bVal: number,
  higherIsBetter: boolean,
): "a" | "b" | "tie" {
  if (aVal === bVal) return "tie";
  if (higherIsBetter) return aVal > bVal ? "a" : "b";
  return aVal < bVal ? "a" : "b";
}

export function CompareBenchCard({
  bench,
  aName,
  bName,
}: {
  bench: CompareBench;
  aName: string;
  bName: string;
}) {
  const hasScopes = bench.panelScopes.length > 0;

  return (
    <article className="border border-rule rounded-2xl p-5 sm:p-6">
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="display text-base sm:text-lg tracking-tight text-ink leading-tight">
          <Link href={`/benchmarks/${bench.slug}`} className="hover:underline">
            {bench.title}
          </Link>
        </h3>
        <span className="text-[10px] uppercase tracking-[0.16em] text-ink-faint shrink-0">
          {bench.category}
        </span>
      </header>

      {hasScopes ? (
        <ScopeTable bench={bench} aName={aName} bName={bName} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            <AggregatePanel
              name={aName}
              value={bench.aResult.p50}
              details={bench.aResult}
              unit={bench.unit}
              winner={bench.aggregateWinner === "a"}
              loser={bench.aggregateWinner === "b"}
            />
            <AggregatePanel
              name={bName}
              value={bench.bResult.p50}
              details={bench.bResult}
              unit={bench.unit}
              winner={bench.aggregateWinner === "b"}
              loser={bench.aggregateWinner === "a"}
            />
          </div>

          {bench.chainRegionMatrix.length > 0 ? (
            <ChainRegionMatrix
              entries={bench.chainRegionMatrix}
              aName={aName}
              bName={bName}
              unit={bench.unit}
            />
          ) : (
            <>
              {bench.chainBreakdown.length > 0 && (
                <BreakdownTable
                  title="Per chain"
                  rows={bench.chainBreakdown}
                  aName={aName}
                  bName={bName}
                  unit={bench.unit}
                />
              )}
              {bench.regionBreakdown.length > 0 && (
                <BreakdownTable
                  title="Per region"
                  rows={bench.regionBreakdown}
                  aName={aName}
                  bName={bName}
                  unit={bench.unit}
                />
              )}
            </>
          )}
        </>
      )}

      {bench.note && (
        <p className="mt-4 text-[11px] text-ink-faint leading-snug border-t border-rule pt-3">
          {bench.note}
        </p>
      )}

      <footer className="mt-4 border-t border-rule pt-3 flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
        <span>Rolling 24h · {bench.metric}</span>
        <Link
          href={`/api/stat/${bench.slug}`}
          className="hover:text-ink-soft normal-case tracking-normal"
        >
          Raw JSON
        </Link>
      </footer>
    </article>
  );
}

/** Multi-column table for benches with metric panels. One row per provider,
 *  one column per scope. Winner per column is highlighted. */
function ScopeTable({
  bench,
  aName,
  bName,
}: {
  bench: CompareBench;
  aName: string;
  bName: string;
}) {
  const cols = bench.panelScopes;

  return (
    <div className="overflow-x-auto -mx-5 sm:-mx-6 px-5 sm:px-6">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.16em] text-ink-faint border-b border-rule">
            <th className="text-left font-medium py-2 pr-4 sticky left-0 bg-bg z-10 min-w-[80px]">
              Provider
            </th>
            {cols.map((c) => (
              <th
                key={c.id}
                className="text-right font-medium py-2 px-3 whitespace-nowrap"
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(["a", "b"] as const).map((side) => {
            const name = side === "a" ? aName : bName;
            return (
              <tr key={side} className="border-t border-rule">
                <td className="py-3 pr-4 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted sticky left-0 bg-bg border-r border-rule/40">
                  {name}
                </td>
                {cols.map((c) => {
                  const val = side === "a" ? c.aValue : c.bValue;
                  const winner = decideWinner(c.aValue, c.bValue, c.higherIsBetter);
                  const leads = !c.neutral && winner === side;
                  const trails = !c.neutral && winner !== side && winner !== "tie";
                  const hasData = val > 0;
                  return (
                    <td
                      key={c.id}
                      className={`py-3 px-3 text-right tabular whitespace-nowrap ${
                        !hasData
                          ? "text-ink-faint"
                          : leads
                            ? "text-good font-semibold"
                            : trails
                              ? "text-bad"
                              : "text-ink"
                      }`}
                    >
                      {hasData ? fmtUnit(val, c.unit) : "-"}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AggregatePanel({
  name,
  value,
  details,
  unit,
  winner,
  loser,
}: {
  name: string;
  value: number;
  details: Panel | null;
  unit: Benchmark["unit"];
  winner: boolean;
  loser: boolean;
}) {
  const hasData = value > 0;
  const containerCls = winner
    ? "border-good/60 bg-good/5"
    : loser
      ? "border-bad/40 bg-bad/5"
      : "border-rule bg-surface";
  const headlineCls = winner ? "text-good" : loser ? "text-bad" : "text-ink";

  return (
    <div className={`rounded-xl px-4 py-4 border flex flex-col gap-2 ${containerCls}`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] uppercase tracking-[0.16em] text-ink-muted font-medium">
          {name}
        </p>
        {winner && hasData && (
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-good">
            Leads
          </span>
        )}
        {loser && hasData && (
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-bad">
            Trails
          </span>
        )}
      </div>
      {hasData ? (
        <>
          <p className={`display text-3xl sm:text-4xl tracking-tight tabular leading-none ${headlineCls}`}>
            {fmtValue(value, unit)}
            <span className="ml-1 text-base text-ink-muted">
              {unitSuffix(unit, value)}
            </span>
          </p>
          {details && (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-ink-muted tabular">
              {(details.sampleSize ?? 0) >= 100 ? (
                <>
                  <dt>p99</dt>
                  <dd className="text-right text-ink-soft">{fmtUnit(details.p99, unit)}</dd>
                </>
              ) : null}
              <dt>rank</dt>
              <dd className="text-right text-ink-soft">
                {details.rank > 0 ? `#${details.rank}` : "—"}
              </dd>
              {details.sampleSize ? (
                <>
                  <dt>samples</dt>
                  <dd className="text-right text-ink-soft">
                    {Math.round(details.sampleSize).toLocaleString()}
                    {details.sampleSize < 100 && (
                      <span
                        className="ml-1 text-amber-400/80"
                        title="Fewer than 100 samples — treat as provisional"
                      >
                        provisional
                      </span>
                    )}
                  </dd>
                </>
              ) : null}
            </dl>
          )}
        </>
      ) : (
        <p className="text-sm text-ink-faint">No data in window</p>
      )}
    </div>
  );
}

function ChainRegionMatrix({
  entries,
  aName,
  bName,
  unit,
}: {
  entries: ChainRegionEntry[];
  aName: string;
  bName: string;
  unit: Benchmark["unit"];
}) {
  const regionMap = new Map<string, string>();
  for (const entry of entries) {
    for (const r of entry.regionRows) {
      if (!regionMap.has(r.value)) regionMap.set(r.value, r.label);
    }
  }
  const regions = Array.from(regionMap.entries()).map(([value, label]) => ({ value, label }));

  const valueCell = (win: boolean, lose: boolean, isAggregate = false) => {
    const color = win ? "text-good font-medium" : lose ? "text-bad" : "text-ink";
    return `py-2 px-2 text-right whitespace-nowrap ${isAggregate ? "border-l border-rule" : ""} ${color}`;
  };
  const emptyCell = (isAggregate = false) =>
    `py-2 px-2 text-right text-ink-faint ${isAggregate ? "border-l border-rule" : ""}`;

  return (
    <div className="mt-6 border-t border-rule pt-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-medium mb-3">
        Per chain · per region
      </p>
      <div className="overflow-x-auto -mx-5 sm:-mx-6 px-5 sm:px-6">
        <table className="w-full text-sm tabular border-collapse">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.16em] text-ink-faint border-b border-rule">
              <th scope="col" className="text-left font-medium py-2 pr-3 sticky left-0 bg-bg z-10">
                Chain
              </th>
              <th scope="col" className="text-left font-medium py-2 px-3">
                Provider
              </th>
              {regions.map((r) => (
                <th key={r.value} scope="col" className="text-right font-medium py-2 px-2">
                  {r.label}
                </th>
              ))}
              <th scope="col" className="text-right font-medium py-2 pl-3 pr-1 border-l border-rule">
                Aggregate
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const byRegion = new Map(entry.regionRows.map((r) => [r.value, r] as const));
              return (
                <Fragment key={entry.value}>
                  <tr className="border-t border-rule">
                    <th
                      scope="rowgroup"
                      rowSpan={2}
                      className="py-2 pr-3 text-left text-ink-soft font-medium align-top sticky left-0 bg-bg border-r border-rule/60"
                    >
                      {entry.label}
                    </th>
                    <td className="py-2 px-3 text-[11px] uppercase tracking-[0.14em] text-ink-muted">
                      {aName}
                    </td>
                    {regions.map((r) => {
                      const row = byRegion.get(r.value);
                      return row ? (
                        <td key={r.value} className={valueCell(row.aWins, row.bWins)}>
                          {fmtUnit(row.aP50, unit)}
                        </td>
                      ) : (
                        <td key={r.value} className={emptyCell()}>-</td>
                      );
                    })}
                    <td className={valueCell(entry.aWins, entry.bWins, true)}>
                      {fmtUnit(entry.aP50, unit)}
                    </td>
                  </tr>
                  <tr className="border-b border-rule">
                    <td className="py-2 px-3 text-[11px] uppercase tracking-[0.14em] text-ink-muted">
                      {bName}
                    </td>
                    {regions.map((r) => {
                      const row = byRegion.get(r.value);
                      return row ? (
                        <td key={r.value} className={valueCell(row.bWins, row.aWins)}>
                          {fmtUnit(row.bP50, unit)}
                        </td>
                      ) : (
                        <td key={r.value} className={emptyCell()}>-</td>
                      );
                    })}
                    <td className={valueCell(entry.bWins, entry.aWins, true)}>
                      {fmtUnit(entry.bP50, unit)}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
  aName,
  bName,
  unit,
}: {
  title: string;
  rows: BreakdownRow[];
  aName: string;
  bName: string;
  unit: Benchmark["unit"];
}) {
  return (
    <div className="mt-6 border-t border-rule pt-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-medium mb-3">
        {title}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.16em] text-ink-faint border-b border-rule">
              <th className="text-left font-medium pb-2 pr-3">
                {title === "Per region" ? "Region" : "Chain"}
              </th>
              <th className="text-right font-medium pb-2 px-3">{aName}</th>
              <th className="text-right font-medium pb-2 pl-3">{bName}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.map((row) => (
              <tr key={row.value}>
                <td className="py-2 pr-3 text-ink-soft">{row.label}</td>
                <td className={`py-2 px-3 text-right ${row.aWins ? "text-good font-medium" : row.bWins ? "text-bad" : "text-ink"}`}>
                  {fmtUnit(row.aP50, unit)}
                </td>
                <td className={`py-2 pl-3 text-right ${row.bWins ? "text-good font-medium" : row.aWins ? "text-bad" : "text-ink"}`}>
                  {fmtUnit(row.bP50, unit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
