"use client";

import { useMemo } from "react";

import Link from "next/link";
import type { Benchmark, ProviderResult } from "@/types/benchmark";
import { Sparkline } from "@/components/sparkline";
import { ProviderLogo } from "@/components/provider-logo";
import { ProviderTypeBadge } from "@/components/provider-type-badge";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";
import { isRegion } from "@/lib/brand";

type Props = {
  benchmark: Benchmark;
};

/**
 * Dense KPI ledger. every provider rendered in its signature color
 * (matched to the time-series chart) so a reader can scan rows and lines
 * without re-reading the legend. The colour assignment is purely an aid
 * to recognition; sort order remains mechanical (ascending p50) and no
 * row is highlighted as the "winner".
 */
export function LedgerTable({ benchmark }: Props) {
  const { results, unit, extras } = benchmark;
  const secondary = results[0]?.secondary?.label;
  // Detected from the first provider's results — if ANY provider declares
  // slot_p50/slot_p99 in its YAML queries, every row gets the column (with
  // "-" for providers that don't declare it). Used by Solana-native benches
  // where slot_delta is the canonical metric and ms is wall-clock derived.
  const hasSlots = results.some((r) => r.slots != null);
  // Sort by p50 then push unavailable providers to the bottom. Without
  // the secondary sort they'd land at rank #1 on lower-is-better benches
  // because their placeholder p50 is 0 - which is what made 0slot, then
  // cardano, show up as "fastest" in the recent SERP screenshots.
  const sorted = [...results].sort((a, b) => {
    const aOff = a.availability === "unavailable" ? 1 : 0;
    const bOff = b.availability === "unavailable" ? 1 : 0;
    if (aOff !== bOff) return aOff - bOff;
    return benchmark.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50;
  });
  const colors = useMemo(() => buildProviderColors(results), [results]);

  const allSeries = Object.values(extras.series24h).flat();
  const sparkMin = allSeries.length ? Math.min(...allSeries) : 0;
  const sparkMax = allSeries.length ? Math.max(...allSeries) : 1;

  // Maximum p50 across the field. used to size the inline data bar
  const maxP50 = Math.max(...results.map((r) => r.ms.p50)) || 1;

  const fieldP50 =
    results.reduce((s, r) => s + r.ms.p50, 0) / Math.max(1, results.length);

  return (
    <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
      <table className="ledger w-full min-w-[480px] md:min-w-0 border-collapse">
        <thead>
          <tr>
            <th colSpan={3} className="border-y-2 border-ink py-2 pr-3 text-left">
              Product
            </th>
            <th
              colSpan={5}
              className="border-y-2 border-ink py-2 px-3 text-center hidden md:table-cell"
            >
              Latency aggregates
            </th>
            <th className="border-y-2 border-ink py-2 px-3 text-right md:hidden">p50</th>
            <th className="border-y-2 border-ink py-2 pl-3 text-right hidden md:table-cell">
              Reliability
            </th>
            <th className="border-y-2 border-ink py-2 pl-3 text-right">Trend</th>
            {hasSlots && (
              <th
                className="border-y-2 border-ink py-2 pl-3 text-right"
                title="Slot delta = number of Solana slots between submit and confirmed. Canonical on-chain measurement (~400 ms per slot)."
              >
                Slot delta
              </th>
            )}
            {secondary && (
              <th className="border-y-2 border-ink py-2 pl-3 text-right">
                {secondary}
              </th>
            )}
          </tr>
          <tr>
            <th className="py-2 pr-2 text-left w-2"></th>
            <th className="py-2 pr-3 text-left w-10">№</th>
            <th className="py-2 pr-3 text-left">Name</th>
            <th className="py-2 px-3 text-right">p50</th>
            <th className="py-2 px-3 text-right hidden md:table-cell">p90</th>
            <th className="py-2 px-3 text-right hidden md:table-cell">p99</th>
            <th className="py-2 px-3 text-right hidden md:table-cell">Mean</th>
            <th className="py-2 px-3 text-right hidden md:table-cell">Δ field</th>
            <th className="py-2 px-3 text-right hidden md:table-cell">Success</th>
            <th className="py-2 pl-3 text-right">24h</th>
            {hasSlots && <th className="py-2 pl-3 text-right">p50 / p99</th>}
            {secondary && <th className="py-2 pl-3 text-right">Value</th>}
          </tr>
          <tr className="border-b border-ink">
            <th
              colSpan={10 + (hasSlots ? 1 : 0) + (secondary ? 1 : 0)}
              className="h-px p-0"
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <Row
              key={r.slug}
              r={r}
              i={i}
              unit={unit}
              fieldP50={fieldP50}
              maxP50={maxP50}
              hasSecondary={!!secondary}
              hasSlots={hasSlots}
              series={extras.series24h[r.slug] ?? []}
              sparkMin={sparkMin}
              sparkMax={sparkMax}
              color={colors.get(r.slug) ?? "var(--color-ink-soft)"}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  r,
  i,
  unit,
  fieldP50,
  maxP50,
  hasSecondary,
  hasSlots,
  series,
  sparkMin,
  sparkMax,
  color,
}: {
  r: ProviderResult;
  i: number;
  unit: string;
  fieldP50: number;
  maxP50: number;
  hasSecondary: boolean;
  hasSlots: boolean;
  series: number[];
  sparkMin: number;
  sparkMax: number;
  color: string;
}) {
  const isOffline = r.availability === "unavailable";
  const deltaPct = fieldP50 > 0 ? ((r.ms.p50 - fieldP50) / fieldP50) * 100 : 0;
  const deltaSign = deltaPct > 0 ? "+" : deltaPct < 0 ? "−" : "±";
  // Inline p50 bar width relative to the field max
  const barPct = Math.max(2, (r.ms.p50 / maxP50) * 100);

  return (
    <tr className={`border-b border-rule transition-colors hover:bg-paper-soft/50 ${isOffline ? "opacity-65" : ""}`}>
      {/* Color accent. left edge of row */}
      <td
        className="p-0 align-middle"
        style={{ width: 4 }}
      >
        <span
          className="block w-[3px] h-7 rounded-sm"
          style={{ background: isOffline ? "var(--color-ink-faint)" : color }}
          aria-hidden
        />
      </td>
      <td className="py-2.5 pr-3 text-ink-muted text-[12px]">
        {String(i + 1).padStart(2, "0")}
      </td>
      <td className="py-2.5 pr-3 font-serif text-[14px] min-w-0">
        <span className="flex items-center gap-2 min-w-0">
          <ProviderLogo slug={r.slug} name={r.name} size={20} />
          {isRegion(r.slug) ? (
            <span
              className="font-semibold truncate min-w-0"
              style={{ color: isOffline ? "var(--color-ink-muted)" : color }}
            >
              {r.name}
            </span>
          ) : (
            <Link
              href={`/products/${r.slug}`}
              className="font-semibold hover:underline underline-offset-2 truncate min-w-0"
              style={{ color: isOffline ? "var(--color-ink-muted)" : color }}
            >
              {r.name}
            </Link>
          )}
          {r.tag && !isOffline && (
            <span className="hidden sm:inline-block truncate max-w-[140px] md:max-w-[220px] font-sans text-[10px] uppercase tracking-[0.14em] text-ink-muted">
              {r.tag}
            </span>
          )}
          {isOffline && (
            <span
              className="inline-flex items-center gap-1 shrink-0 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-muted"
              title="No samples returned this cycle — provider or its upstream is currently unavailable. Values will reappear once data resumes."
            >
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-warn,#c08a3c)]" aria-hidden />
              Currently unavailable
            </span>
          )}
          {r.type && !isOffline && (
            <span className="hidden md:inline-flex">
              <ProviderTypeBadge type={r.type} />
            </span>
          )}
        </span>
      </td>
      {isOffline ? (
        <td
          colSpan={7 + (hasSlots ? 1 : 0) + (hasSecondary ? 1 : 0)}
          className="py-2.5 px-3 text-right text-ink-faint italic text-[12px]"
        >
          Awaiting next successful scrape
        </td>
      ) : (
        <>
          {/* p50 with inline data bar */}
          <td className="py-2.5 px-3 text-right whitespace-nowrap">
            <span className="inline-flex items-center gap-2 justify-end">
              <span
                className="hidden sm:inline-block h-1.5 rounded-sm"
                style={{
                  width: `${barPct * 0.45}px`,
                  background: `${color}26`, // 15% alpha
                  borderLeft: `2px solid ${color}`,
                }}
                aria-hidden
              />
              <span className="text-ink whitespace-nowrap">
                {fmtUnit(r.ms.p50, unit)}
              </span>
            </span>
          </td>
          <td className="py-2.5 px-3 text-right text-ink-soft whitespace-nowrap hidden md:table-cell">
            {fmtUnit(r.ms.p90, unit)}
          </td>
          <td className="py-2.5 px-3 text-right text-ink-soft whitespace-nowrap hidden md:table-cell">
            {fmtUnit(r.ms.p99, unit)}
          </td>
          <td className="py-2.5 px-3 text-right text-ink-soft whitespace-nowrap hidden md:table-cell">
            {fmtUnit(r.ms.mean, unit)}
          </td>
          <td className="py-2.5 px-3 text-right text-ink-muted whitespace-nowrap hidden md:table-cell">
            {fieldP50 > 0 ? `${deltaSign}${Math.abs(deltaPct).toFixed(0)}%` : "-"}
          </td>
          <td className="py-2.5 px-3 text-right text-ink-soft whitespace-nowrap hidden md:table-cell">
            {r.successRate.toFixed(2)}%
          </td>
          <td className="py-2.5 pl-3 text-right">
            <span className="inline-flex items-center justify-end">
              <Sparkline
                values={series}
                color={color}
                globalMin={sparkMin}
                globalMax={sparkMax}
              />
            </span>
          </td>
          {hasSlots && (
            <td
              className="py-2.5 pl-3 text-right text-ink-soft whitespace-nowrap font-mono text-[12px]"
              title="p50 / p99 slot delta — canonical Solana on-chain measurement"
            >
              {r.slots
                ? `${r.slots.p50.toFixed(0)} / ${r.slots.p99.toFixed(0)}`
                : "-"}
            </td>
          )}
          {hasSecondary && (
            <td className="py-2.5 pl-3 text-right text-ink-soft">
              {r.secondary?.value ?? "-"}
            </td>
          )}
        </>
      )}
    </tr>
  );
}
