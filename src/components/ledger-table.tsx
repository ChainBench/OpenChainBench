"use client";

import { useMemo, useState } from "react";

import Link from "next/link";
import type {
  Benchmark,
  LedgerColumn,
  MetricPanel,
  ProviderResult,
} from "@/types/benchmark";
import { ChainCoverageChip } from "@/components/chain-coverage-chip";
import { EmbedBadgeButton } from "@/components/embed-badge-button";
import { Hint } from "@/components/hint";
import { Sparkline } from "@/components/sparkline";
import { ProviderLogo } from "@/components/provider-logo";
import { ProviderTypeBadge } from "@/components/provider-type-badge";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";
import { isRegion } from "@/lib/brand";
import { isAll } from "@/lib/dimensions";

type Props = {
  benchmark: Benchmark;
  /** When the bench page has a companion-panel tab selected on the
   *  chart, the ledger mirrors it so chart + table show the same
   *  providers in the same order. When null/undefined the ledger uses
   *  the headline p50 metric. */
  activePanel?: MetricPanel | null;
  topN?: number | null;
  /** Active dimension filters on the bench page. Passed through to the
   *  per-row Embed CTA so the generated snippet/badge stay scoped to what
   *  the reader is looking at. "all" sentinels are normalized to null. */
  scopeChain?: string | null;
  scopeRegion?: string | null;
  scopeKind?: string | null;
};

/**
 * Dense KPI ledger. every provider rendered in its signature color
 * (matched to the time-series chart) so a reader can scan rows and lines
 * without re-reading the legend. The colour assignment is purely an aid
 * to recognition; sort order remains mechanical (ascending p50) and no
 * row is highlighted as the "winner".
 */
export function LedgerTable({
  benchmark,
  activePanel,
  topN,
  scopeChain = null,
  scopeRegion = null,
  scopeKind = null,
}: Props) {
  const { results, extras } = benchmark;
  // Drop "all" sentinels so the snippet/badge URL stays unscoped instead
  // of carrying ?chain=all (which the badge route 400s on).
  const embedChain = scopeChain && !isAll(scopeChain) ? scopeChain : null;
  const embedRegion = scopeRegion && !isAll(scopeRegion) ? scopeRegion : null;
  const embedKind = scopeKind && !isAll(scopeKind) ? scopeKind : null;
  const unit = activePanel?.unit ?? benchmark.unit;
  const higherIsBetter = activePanel?.higherIsBetter ?? benchmark.higherIsBetter;
  const panelActive = !!activePanel;
  // Custom column mode: benches that repurpose the p50/p90/p99/mean slots
  // (USD revenue leaderboards) declare ledger_columns in their YAML so
  // every column carries an honest label + unit, and panel-backed columns
  // (e.g. unique users) surface inline instead of behind a tab click.
  // Disabled while a panel tab is active — the panel sort already owns
  // the table and the aggregate columns are dashed out.
  const customCols = !panelActive ? benchmark.ledgerColumns : undefined;
  const panelById = useMemo(
    () => new Map((benchmark.metricPanels ?? []).map((p) => [p.id, p])),
    [benchmark.metricPanels],
  );
  const secondary = customCols ? undefined : results[0]?.secondary?.label;

  // Resolve one custom column's value for a row. Slot columns read the
  // repurposed headline slots; panel columns read the panel's values map
  // (null when the provider returned no data for that metric this cycle).
  const colValue = (r: ProviderResult, col: LedgerColumn): number | null => {
    if (col.slot) return r.ms[col.slot];
    const v = panelById.get(col.panel ?? "")?.values[r.slug];
    return v != null && Number.isFinite(v) ? v : null;
  };
  const colUnit = (col: LedgerColumn): string =>
    col.unit ??
    (col.panel ? (panelById.get(col.panel)?.unit ?? unit) : unit);

  // Timeframe toggle. Columns that declare `windows` (7d/30d panel-id
  // sources) flip to the selected window's values; columns without keep
  // their 24h figure and the header says so. Rendered only when at least
  // one column declares windows.
  const [windowKey, setWindowKey] = useState<"24h" | "7d" | "30d">("24h");
  const hasWindows = !!customCols?.some(
    (c) => c.windows && Object.keys(c.windows).length > 0,
  );
  const colValueW = (r: ProviderResult, col: LedgerColumn): number | null => {
    if (windowKey !== "24h" && col.windows?.[windowKey]) {
      const v = panelById.get(col.windows[windowKey])?.values[r.slug];
      return v != null && Number.isFinite(v) ? v : null;
    }
    return colValue(r, col);
  };
  const colLabel = (col: LedgerColumn): string => {
    if (!hasWindows) return col.label;
    const w = windowKey !== "24h" && col.windows?.[windowKey] ? windowKey : "24h";
    return `${col.label} (${w})`;
  };

  // Single source of value per row — headline slot p50, the active
  // window's first custom column, or `panel.values[slug]` when a panel
  // tab is active. Used for sort, filter, the inline data bar, and the
  // displayed value in the headline column.
  const pickValue = (r: ProviderResult): number => {
    if (activePanel) return activePanel.values[r.slug] ?? 0;
    if (customCols) return colValueW(r, customCols[0]) ?? 0;
    return r.ms.p50;
  };
  // Detected from the first provider's results — if ANY provider declares
  // slot_p50/slot_p99 in its YAML queries, every row gets the column (with
  // "-" for providers that don't declare it). Used by Solana-native benches
  // where slot_delta is the canonical metric and ms is wall-clock derived.
  const hasSlots = !customCols && results.some((r) => r.slots != null);
  // Drop unscored providers (availability=unavailable AND p50=0). They
  // stay in the underlying spec so /products/<slug> pages still resolve
  // and SEO coverage holds, but they're noise in a "ranked by performance"
  // ledger. Mirrors the filter the ranked-bar chart applies above so the
  // two surfaces tell the same story.
  // Sort by p50; unavailable rows with non-zero p50 (rare, e.g. cached
  // values served while a brief Prom outage was recovering) still get
  // pushed to the bottom.
  // Drop rows with no headline-metric value. Catches three flavours
  // collapsed into a single check:
  //   1. true unavailable (Prom returned nothing, augmented as zero)
  //   2. backstop-promoted rows that flipped availability=live based on
  //      companion-panel data but still have p50=0 on the headline
  //   3. rare genuine zero (e.g. a builder that levied zero fees in the
  //      24h window). Edge case — acceptable cost to keep the leaderboard
  //      free of "0% / -100% Δ field" rows that read as broken to the
  //      first-time visitor.
  // The chart's panel tabs still surface those providers via
  // seriesByProvider when the reader switches metric, so coverage isn't
  // lost — only the noisy ledger rows are pruned.
  const sortedAll = [...results]
    .filter((r) => {
      if (activePanel) {
        const v = activePanel.values[r.slug];
        return v != null && Number.isFinite(v) && v !== 0;
      }
      // Prune only all-zero rows (dead latency providers emit 0s).
      // Comparing with > 0 dropped legitimately NEGATIVE rows on signed
      // benches: perp-funding's OKX (paid on ETH, BTC and SOL, all three
      // slots negative) vanished from the ledger while leading the chart.
      return r.ms.p50 !== 0 || r.ms.p90 !== 0 || r.ms.p99 !== 0;
    })
    .sort((a, b) => {
      const av = pickValue(a);
      const bv = pickValue(b);
      return higherIsBetter ? bv - av : av - bv;
    });
  const sorted = topN == null ? sortedAll : sortedAll.slice(0, topN);
  const colors = useMemo(() => buildProviderColors(results), [results]);

  // Sparkline scale must follow the active source. When a panel tab is
  // selected the ledger pulls series from panel.seriesByProvider (e.g.
  // last-fill-age in seconds, 0–thousands) instead of extras.series24h
  // (the headline metric, often a few bps or ms). Reusing the headline
  // min/max projects panel values wildly out of bounds and the trend
  // column renders vertical streaks running off the row.
  const sparkSource = activePanel?.seriesByProvider ?? extras.series24h;
  const allSeries = Object.values(sparkSource).flat();
  const sparkMin = allSeries.length ? Math.min(...allSeries) : 0;
  const sparkMax = allSeries.length ? Math.max(...allSeries) : 1;

  // Max + field-mean of the active column. Computed off `sorted` (the
  // scored set) so the field mean isn't pulled to zero by augmented
  // unavailable rows, which would flatten every delta to +999%.
  const maxValue = Math.max(...sorted.map((r) => pickValue(r))) || 1;
  const fieldValue =
    sorted.reduce((s, r) => s + pickValue(r), 0) / Math.max(1, sorted.length);

  return (
    <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
      {hasWindows && (
        <div className="mb-3 flex flex-wrap items-center gap-1">
          <span className="mr-2 label-mono-xs">
            Timeframe
          </span>
          {(["24h", "7d", "30d"] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindowKey(w)}
              className={[
                "rounded px-2.5 py-1 text-[11px] font-sans tabular uppercase tracking-[0.1em] font-medium transition-colors",
                windowKey === w
                  ? "bg-ink text-paper"
                  : "text-ink-muted hover:text-ink hover:bg-paper-soft",
              ].join(" ")}
            >
              {w}
            </button>
          ))}
        </div>
      )}
      <table className="ledger w-full min-w-full sm:min-w-[480px] md:min-w-0 border-collapse">
        <thead>
          <tr>
            <th colSpan={3} className="border-y-2 border-ink py-2 pr-3 text-left">
              Product
            </th>
            <th
              colSpan={customCols ? customCols.length + 1 : activePanel ? 2 : 5}
              className="border-y-2 border-ink py-2 px-3 text-center hidden md:table-cell"
            >
              {customCols
                ? benchmark.metric
                : activePanel
                  ? activePanel.label
                  : "Latency aggregates"}
            </th>
            <th className="border-y-2 border-ink py-2 px-3 text-right md:hidden">
              {customCols ? colLabel(customCols[0]) : activePanel ? "Value" : "p50"}
            </th>
            <th className="border-y-2 border-ink py-2 pl-3 text-right hidden md:table-cell">
              Reliability
            </th>
            <th className="border-y-2 border-ink py-2 pl-3 text-right">Trend</th>
            {hasSlots && (
              <th
                className="border-y-2 border-ink py-2 pl-3 text-right hidden md:table-cell"
                title="Slot delta = number of Solana slots between submit and confirmed. Canonical on-chain measurement (~400 ms per slot)."
              >
                Slot delta
              </th>
            )}
            {secondary && (
              <th className="border-y-2 border-ink py-2 pl-3 text-right hidden md:table-cell">
                {secondary}
              </th>
            )}
          </tr>
          <tr>
            <th className="py-2 pr-2 text-left w-2"></th>
            <th className="py-2 pr-3 text-left w-10">№</th>
            <th className="py-2 pr-3 text-left">Name</th>
            {customCols ? (
              customCols.map((c, idx) => (
                <th
                  key={c.label}
                  className={`py-2 px-3 text-right ${idx === 0 ? "" : "hidden md:table-cell"}`}
                >
                  {colLabel(c)}
                </th>
              ))
            ) : panelActive ? (
              // Panel sort owns the table: a single honest "Value" column
              // instead of p50/p90/p99/Mean headers over dashed-out cells
              // (a USD volume sort labeled "p50" reads as a bug).
              <th className="py-2 px-3 text-right">Value</th>
            ) : (
              <>
                <th className="py-2 px-3 text-right">p50</th>
                <th className="py-2 px-3 text-right hidden md:table-cell">p90</th>
                <th className="py-2 px-3 text-right hidden md:table-cell">p99</th>
                <th className="py-2 px-3 text-right hidden md:table-cell">Mean</th>
              </>
            )}
            <th className="py-2 px-3 text-right hidden md:table-cell">Δ field</th>
            <th className="py-2 px-3 text-right hidden md:table-cell">Success</th>
            <th className="py-2 pl-3 text-right">24h</th>
            {hasSlots && <th className="py-2 pl-3 text-right hidden md:table-cell">p50 / p99</th>}
            {secondary && <th className="py-2 pl-3 text-right hidden md:table-cell">Value</th>}
          </tr>
          <tr className="border-b border-ink">
            <th
              colSpan={
                (customCols ? 6 + customCols.length : panelActive ? 7 : 10) +
                (hasSlots ? 1 : 0) +
                (secondary ? 1 : 0)
              }
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
              value={pickValue(r)}
              fieldValue={fieldValue}
              maxValue={maxValue}
              panelActive={panelActive}
              hasSecondary={!!secondary}
              hasSlots={hasSlots}
              customCells={customCols?.map((c) => ({
                v: colValueW(r, c),
                unit: colUnit(c),
              }))}
              series={
                activePanel
                  ? (activePanel.seriesByProvider?.[r.slug] ?? [])
                  : (extras.series24h[r.slug] ?? [])
              }
              sparkMin={sparkMin}
              sparkMax={sparkMax}
              color={colors.get(r.slug) ?? "var(--color-ink-soft)"}
              benchmark={benchmark}
              embedChain={embedChain}
              embedRegion={embedRegion}
              embedKind={embedKind}
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
  value,
  fieldValue,
  maxValue,
  panelActive,
  hasSecondary,
  hasSlots,
  customCells,
  series,
  sparkMin,
  sparkMax,
  color,
  benchmark,
  embedChain,
  embedRegion,
  embedKind,
}: {
  r: ProviderResult;
  i: number;
  unit: string;
  value: number;
  fieldValue: number;
  maxValue: number;
  panelActive: boolean;
  hasSecondary: boolean;
  hasSlots: boolean;
  /** Custom-column mode (benchmark.ledgerColumns): one pre-resolved
   *  {value, unit} per declared column, replacing p50/p90/p99/Mean. */
  customCells?: { v: number | null; unit: string }[];
  series: number[];
  sparkMin: number;
  sparkMax: number;
  color: string;
  benchmark: Benchmark;
  embedChain: string | null;
  embedRegion: string | null;
  embedKind: string | null;
}) {
  const isOffline = r.availability === "unavailable";
  const deltaPct = fieldValue > 0 ? ((value - fieldValue) / fieldValue) * 100 : 0;
  const deltaSign = deltaPct > 0 ? "+" : deltaPct < 0 ? "−" : "±";
  const barPct = Math.max(2, (value / maxValue) * 100);

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
      {/* itemScope/itemType marks each row as a named entity so Google's
          knowledge graph can link the leaderboard back to that provider.
          For region rows (Solana, Base, …) the schema.org/Place type is
          a better fit than Organization; everything else is a vendor and
          gets Organization. itemProp="name" wraps the visible name. */}
      <td
        className="py-2.5 pr-3 font-serif text-[14px] min-w-0"
        itemScope
        itemType={
          isRegion(r.slug)
            ? "https://schema.org/Place"
            : "https://schema.org/Organization"
        }
      >
        <div className="flex flex-col gap-1 min-w-0">
          <span className="flex items-center gap-2 min-w-0">
            <ProviderLogo slug={r.slug} name={r.name} size={20} />
            {isRegion(r.slug) ? (
              <span
                className="font-semibold truncate min-w-0"
                style={{ color: isOffline ? "var(--color-ink-muted)" : color }}
                itemProp="name"
              >
                {r.name}
              </span>
            ) : (
              <Link
                href={`/products/${r.slug}`}
                className="font-semibold hover:underline underline-offset-2 truncate min-w-0"
                style={{ color: isOffline ? "var(--color-ink-muted)" : color }}
                itemProp="url"
              >
                <span itemProp="name">{r.name}</span>
              </Link>
            )}
            {r.tag && !isOffline && (
              <span className="hidden sm:inline-block truncate max-w-[140px] md:max-w-[220px] font-sans text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                {r.tag}
              </span>
            )}
            {isOffline && (
              <Hint label="No samples returned this cycle. Provider or its upstream is unavailable. Values reappear once data resumes.">
                <span className="inline-flex items-center gap-1 shrink-0 font-sans text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-warn,#c08a3c)]" aria-hidden />
                  Currently unavailable
                </span>
              </Hint>
            )}
            {r.type && !isOffline && (
              <span className="hidden md:inline-flex">
                <ProviderTypeBadge type={r.type} />
              </span>
            )}
            {!isOffline && !isRegion(r.slug) && (
              <span className="ml-auto pl-2 shrink-0">
                <EmbedBadgeButton
                  benchSlug={benchmark.slug}
                  benchTitle={benchmark.title}
                  providerSlug={r.slug}
                  providerName={r.name}
                  chain={embedChain}
                  region={embedRegion}
                  kind={embedKind}
                />
              </span>
            )}
          </span>
          {/* Per-chain coverage chips on their own row — chain-restricted
              providers like GMGN (Solana-only) are flagged so the unfiltered
              ranking can't be misread as a global #1. Indented to align
              with the name (logo width + gap = 20 + 8 = 28 px). Renders
              nothing when the bench has no per-chain leader data. */}
          {!isOffline && (
            <span className="hidden md:flex flex-wrap items-center gap-1 pl-7">
              <ChainCoverageChip
                providerSlug={r.slug}
                benchmark={benchmark}
                size="xs"
              />
            </span>
          )}
        </div>
      </td>
      {isOffline ? (
        <td
          colSpan={
            (customCells ? customCells.length + 3 : 7) +
            (hasSlots ? 1 : 0) +
            (hasSecondary ? 1 : 0)
          }
          className="py-2.5 px-3 text-right text-ink-faint italic text-[12px]"
        >
          Awaiting next successful scrape
        </td>
      ) : (
        <>
          {/* Headline column with inline data bar */}
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
                {customCells
                  ? customCells[0].v != null
                    ? fmtUnit(customCells[0].v, customCells[0].unit)
                    : "-"
                  : fmtUnit(value, unit)}
              </span>
            </span>
          </td>
          {customCells ? (
            customCells.slice(1).map((c, idx) => (
              <td
                key={idx}
                className="py-2.5 px-3 text-right text-ink-soft whitespace-nowrap hidden md:table-cell"
              >
                {c.v != null ? fmtUnit(c.v, c.unit) : "-"}
              </td>
            ))
          ) : panelActive ? null : (
            <>
              <td className="py-2.5 px-3 text-right text-ink-soft whitespace-nowrap hidden md:table-cell">
                {fmtUnit(r.ms.p90, unit)}
              </td>
              <td className="py-2.5 px-3 text-right text-ink-soft whitespace-nowrap hidden md:table-cell">
                {fmtUnit(r.ms.p99, unit)}
              </td>
              <td className="py-2.5 px-3 text-right text-ink-soft whitespace-nowrap hidden md:table-cell">
                {fmtUnit(r.ms.mean, unit)}
              </td>
            </>
          )}
          <td className="py-2.5 px-3 text-right text-ink-muted whitespace-nowrap hidden md:table-cell">
            {fieldValue > 0 ? `${deltaSign}${Math.abs(deltaPct).toFixed(0)}%` : "-"}
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
              className="py-2.5 pl-3 text-right text-ink-soft whitespace-nowrap font-mono text-[12px] hidden md:table-cell"
              title="p50 / p99 slot delta: canonical Solana on-chain measurement"
            >
              {r.slots
                ? `${r.slots.p50.toFixed(0)} / ${r.slots.p99.toFixed(0)}`
                : "-"}
            </td>
          )}
          {hasSecondary && (
            <td className="py-2.5 pl-3 text-right text-ink-soft hidden md:table-cell">
              {r.secondary?.value ?? "-"}
            </td>
          )}
        </>
      )}
    </tr>
  );
}
