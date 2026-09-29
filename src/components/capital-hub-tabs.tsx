"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import {
  CAPITAL_BENCHES,
  fmtPct,
  fmtUsdShort,
  fmtX,
  type CapitalHub,
  type ChainRow,
  type OiRow,
  type PerpRow,
  type ProtocolRow,
} from "@/lib/capital-hub-types";
import {
  CAPITAL_READING,
  NOT_APPLICABLE_LABEL,
  OUTSIDE_COHORT_LABEL,
  SIGNAL_FEE_GROWTH_MIN_PCT,
  SIGNAL_MIN_CATEGORY_MEMBERS,
  SIGNAL_PRICE_MOVE_MIN_PCT,
  SIGNAL_READING,
  UNKNOWN_LABEL,
  bridgedShareSubline,
  cohortCell,
  columnIsWorthShowing,
  fmtUsdLevel,
  isDust,
  levelSortValue,
  naLegend,
  naMarker,
  plainCell,
  printedValue,
  sevenDaySubline,
  signalRowNote,
  type CohortCell,
  type SignalKind,
} from "@/lib/capital-hub-rules";

/**
 * Two cohorts on one page: where the capital sits and moves (chains, open
 * interest) and how tokens are priced against the fees they earn
 * (protocols, perp DEXes). Both tabs render into the HTML under their own
 * H2 and the inactive one is hidden, not unmounted, so crawlers and
 * answer engines read both tables. The client owns only tab and sort state.
 * Display rules (dust, cohort cells, CCTP scope, sub-lines) live in
 * src/lib/capital-hub-rules.ts, shared with the Markdown view.
 */

type Tab = "capital" | "valuation";

export function CapitalHubTabs({ hub }: { hub: CapitalHub }) {
  const hasCapital = hub.chains.length > 0 || hub.pmOi.length > 0 || hub.perpOi.length > 0;
  const hasValuation = hub.protocols.length > 0 || hub.perps.length > 0;
  const [tab, setTab] = useState<Tab>(hasCapital ? "capital" : "valuation");
  // Bench 281 scans seven chains as CCTP sources. That is a real capital-flow
  // reading and too narrow for a column on a 63-row table, so it gets its own
  // block over the chains it covers instead of 56 markers across the page.
  const cctpRows = hub.chains.filter((c) => c.cctpScope === "scanned" && c.cctpNet7d != null);

  return (
    <>
      <div
        className="inline-flex rounded-lg border border-ink/15 p-1 bg-paper-soft/40 mb-4"
        role="tablist"
        aria-label="Capital cohorts"
      >
        <TabButton active={tab === "capital"} onClick={() => setTab("capital")} count={hub.chains.length} disabled={!hasCapital}>
          Follow the capital
        </TabButton>
        <TabButton
          active={tab === "valuation"}
          onClick={() => setTab("valuation")}
          count={hub.protocols.filter((p) => p.signal !== null).length}
          disabled={!hasValuation}
        >
          Valuation divergences
        </TabButton>
      </div>

      {hasCapital && (
        <section hidden={tab !== "capital"} aria-hidden={tab !== "capital"}>
          <h2 className="label-mono text-ink-muted mb-3">Chains ranked by capital: TVL, bridged value, stablecoin flows</h2>
          {hub.chains.length > 0 && <ChainsTable rows={hub.chains} />}
          {hub.chains.length > 0 && <Reading lines={CAPITAL_READING.chains} />}
          {hub.stableFlowShares.length > 0 && <FlowBar shares={hub.stableFlowShares} />}
          {cctpRows.length > 0 && <CctpTable rows={cctpRows} />}
          {(hub.perpOi.length > 0 || hub.pmOi.length > 0) && (
            <>
              <h2 className="label-mono text-ink-muted mt-10 mb-3">Open interest: perp DEXes and prediction markets</h2>
              <div className="grid gap-6 lg:grid-cols-2">
                {hub.perpOi.length > 0 && (
                  <OiTable
                    title="Perp DEX open interest"
                    rows={hub.perpOi}
                    link={(s) => `/products/${s}`}
                    benches={[CAPITAL_BENCHES.perpTurnover]}
                    note="Open interest and 24h volume as each venue's own API reports them, through the perp cohort harness, the same figures the perps hub shows. Turnover is bench 271's ratio of 24-hour averages of those two gauges, so it will not divide exactly into the two columns beside it, which are the latest read. Centralised venues are out; Polymarket and Kalshi sit in the prediction-market table rather than twice on one page."
                  />
                )}
                {hub.pmOi.length > 0 && (
                  <OiTable
                    title="Prediction market open interest"
                    rows={hub.pmOi}
                    link={(s) => `/products/${s}`}
                    benches={[CAPITAL_BENCHES.pmOi]}
                    note="Open interest, 24h volume and turnover all from bench 277, so turnover is this table's volume over this table's open interest."
                  />
                )}
              </div>
              <Reading lines={CAPITAL_READING.openInterest} />
            </>
          )}
        </section>
      )}

      {hasValuation && (
        <section hidden={tab !== "valuation"} aria-hidden={tab !== "valuation"}>
          {hub.protocols.length > 0 && (
            <>
              <h2 className="label-mono text-ink-muted mb-3">Divergences this month: fees up, token down, price to fees under the category median</h2>
              <Divergences rows={hub.divergences} />
              <SignalReadings
                counts={{
                  "fees-up-token-down": hub.protocols.filter((p) => p.signal === "fees-up-token-down").length,
                  "fees-down-token-up": hub.protocols.filter((p) => p.signal === "fees-down-token-up").length,
                }}
              />
              <h2 className="label-mono text-ink-muted mt-10 mb-3">DeFi tokens ranked by price to fees, with fee trend against token move</h2>
              <ProtocolsTable rows={hub.protocols} />
              <Reading lines={CAPITAL_READING.tokens} />
            </>
          )}
          {hub.perps.length > 0 && (
            <>
              <h2 className="label-mono text-ink-muted mt-10 mb-3">Perp DEX tokens: price to fees, price to sales, float and open interest</h2>
              <PerpsTable rows={hub.perps} />
              <Reading lines={CAPITAL_READING.perps} />
            </>
          )}
        </section>
      )}
    </>
  );
}

function TabButton({
  children,
  active,
  count,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  active: boolean;
  count: number;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-colors flex items-center gap-2 ${
        active ? "bg-paper text-ink shadow-sm" : "text-ink-soft hover:text-ink"
      } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      {children}
      <span className="text-[10.5px] text-ink-faint" style={{ fontFamily: "var(--font-mono, monospace)" }}>
        {count}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */

/** Default sort key: the finite number, else null. Module-level so the memo below keeps its identity across renders. */
function numericSortValue(_key: unknown, v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function useSorted<T>(
  rows: T[],
  initialKey: keyof T,
  initialDir: "desc" | "asc" = "desc",
  /** Sort key of one cell; lets a table sort a dust level as 0. */
  sortValue: (key: keyof T, v: unknown) => number | null = numericSortValue,
) {
  const [key, setKey] = useState<keyof T>(initialKey);
  const [dir, setDir] = useState<"desc" | "asc">(initialDir);
  const sorted = useMemo(() => {
    const f = dir === "desc" ? -1 : 1;
    return [...rows].sort((a, b) => {
      const an = sortValue(key, a[key]);
      const bn = sortValue(key, b[key]);
      // Rows without the value sink to the bottom whichever way we sort.
      if (an == null && bn == null) return 0;
      if (an == null) return 1;
      if (bn == null) return -1;
      return f * (an - bn);
    });
  }, [rows, key, dir, sortValue]);
  const toggle = (k: keyof T, defaultDir: "desc" | "asc" = "desc") => {
    if (k === key) setDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setKey(k);
      setDir(defaultDir);
    }
  };
  return { sorted, key, dir, toggle };
}

/** DeFiLlama levels: a value under the dust floor sorts as 0 (it reads "<$1K"). */
const CHAIN_LEVEL_KEYS = new Set<keyof ChainRow>(["tvl", "stablesFloat", "dexVolume24h", "fees30d", "revenue30d"]);
function chainSortValue(key: keyof ChainRow, v: unknown): number | null {
  const n = typeof v === "number" && Number.isFinite(v) ? v : null;
  return CHAIN_LEVEL_KEYS.has(key) ? levelSortValue(n) : n;
}

function ChainsTable({ rows }: { rows: ChainRow[] }) {
  // Every optional column has to cover at least half the cohort, counting a
  // muted out-of-cohort figure as covered. A column that does not is not a
  // column: net USDC over CCTP covers 7 of 63 chains and was painting 56
  // markers across the widest table on the page, which reads as a broken
  // table whatever the legend says. It now has its own block underneath
  // (CctpTable) over the seven chains it does cover.
  const hasTvl = columnIsWorthShowing(rows, (r) => r.tvl);
  const hasBridged = columnIsWorthShowing(rows, (r) => r.bridgedTvl);
  const has7dMedian = columnIsWorthShowing(rows, (r) => r.excess7dPct);
  const hasFloat = columnIsWorthShowing(rows, (r) => r.stablesFloat);
  const hasNetStables = columnIsWorthShowing(rows, (r) => printedValue(r.stablesNet30d, r.stablesNet30dOutside));
  const hasDex = columnIsWorthShowing(rows, (r) => r.dexVolume24h);
  const hasFees = columnIsWorthShowing(rows, (r) => printedValue(r.fees30d, r.fees30dOutside));
  const hasRevenue = columnIsWorthShowing(rows, (r) => printedValue(r.revenue30d, r.revenue30dOutside));
  const { sorted, key, dir, toggle } = useSorted(rows, hasTvl ? "tvl" : "stablesFloat", "desc", chainSortValue);
  // One marker per distinct "does not apply" reason the rendered cells carry,
  // in the order the columns present them, so the legend reads left to right.
  const legend = useMemo(
    () =>
      naLegend([
        ...(hasBridged || has7dMedian ? rows.map((r) => r.notApplicable.bridged) : []),
        ...(hasNetStables ? rows.map((r) => r.notApplicable.stables) : []),
        ...(hasFees || hasRevenue ? rows.map((r) => r.notApplicable.fees) : []),
      ]),
    [rows, hasBridged, has7dMedian, hasNetStables, hasFees, hasRevenue],
  );
  const col = (k: keyof ChainRow, label: string, title?: string, defaultDir: "desc" | "asc" = "desc") => (
    <ThSort active={key === k} dir={dir} onClick={() => toggle(k, defaultDir)} title={title}>
      {label}
    </ThSort>
  );
  return (
    <div className="card-soft rounded-xl border border-ink/10">
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <Th>Chain</Th>
              {hasTvl && col("tvl", "TVL", "DeFi TVL on the chain (DeFiLlama), latest daily point")}
              {hasBridged && col("bridgedTvl", "Bridged value", "Value secured that arrived from another chain, canonical plus external (L2Beat)")}
              {has7dMedian && col("excess7dPct", "7d vs L2 median", "Weekly move of value secured minus the median move across L2Beat projects above $200M")}
              {hasFloat && col("stablesFloat", "Stablecoin float", "Pegged-USD circulating on the chain, every issuer (DeFiLlama)")}
              {hasNetStables && col("stablesNet30d", "Net stables 30d", "Dollar change of the stablecoin float over 30 days; muted for a chain outside the ranked cohort")}
              {hasDex && col("dexVolume24h", "DEX volume 24h", "DEX volume on the chain over the trailing 24 hours (DeFiLlama)")}
              {hasFees && col("fees30d", "Fees 30d", "Fees users paid on the chain over 30 closed days: gas plus every protocol DeFiLlama tracks on it (bench 280); muted for a chain outside the ranked cohort")}
              {hasRevenue && col("revenue30d", "Revenue 30d", "Revenue the chain and its protocols kept out of those fees, per each DeFiLlama adapter")}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={r.slug} className="border-t border-ink/5 hover:bg-paper-soft/40 transition-colors">
                <Td muted mono>
                  {i + 1}
                </Td>
                <Td>
                  {r.hasChainPage ? (
                    <Link href={`/chains/${r.slug}`} className="flex items-center gap-2 min-w-0 hover:underline whitespace-nowrap">
                      <ProviderLogo slug={r.slug} name={r.name} size={18} />
                      <span className="font-medium text-ink">{r.name}</span>
                    </Link>
                  ) : (
                    <span className="flex items-center gap-2 min-w-0 whitespace-nowrap">
                      <ProviderLogo slug={r.slug} name={r.name} size={18} />
                      <span className="font-medium text-ink">{r.name}</span>
                    </span>
                  )}
                </Td>
                {hasTvl && (
                  <Td mono>
                    <Level v={r.tvl} />
                  </Td>
                )}
                {/* Outside the L2Beat cohort the column does not apply and says
                    why (Ethereum is the chain the bridges start from, the rest
                    are L1s with no host chain), so a plain "n/a" keeps meaning
                    "the feed has no value", not "there is nothing to measure". */}
                {hasBridged &&
                  (r.inBridgedCohort ? (
                    <Td mono>
                      {fmtUsdShort(r.bridgedTvl)}
                      {bridgedShareSubline(r.bridgedSharePct) && <Sub>{bridgedShareSubline(r.bridgedSharePct)}</Sub>}
                    </Td>
                  ) : (
                    <NaTd reason={r.notApplicable.bridged} legend={legend} />
                  ))}
                {has7dMedian &&
                  (r.inBridgedCohort ? (
                    <Td mono>
                      <Signed v={r.excess7dPct} fmt={(v) => fmtPct(v)} />
                      {sevenDaySubline(r.change7dPct, r.median7dPct) && <Sub>{sevenDaySubline(r.change7dPct, r.median7dPct)}</Sub>}
                    </Td>
                  ) : (
                    <NaTd reason={r.notApplicable.bridged} legend={legend} />
                  ))}
                {hasFloat && (
                  <Td mono>
                    <Level v={r.stablesFloat} />
                  </Td>
                )}
                {hasNetStables && (
                  <CohortTd
                    cell={cohortCell(r.inStablesCohort, r.stablesNet30d, r.stablesNet30dOutside, r.notApplicable.stables ?? null)}
                    legend={legend}
                    signed
                    fmt={fmtUsdShort}
                    sub={r.stablesChange30dPct != null ? fmtPct(r.stablesChange30dPct) : null}
                  />
                )}
                {hasDex && (
                  <Td mono>
                    <Level v={r.dexVolume24h} />
                  </Td>
                )}
                {hasFees && (
                  <CohortTd
                    cell={cohortCell(r.inFeesCohort, r.fees30d, r.fees30dOutside, r.notApplicable.fees ?? null)}
                    legend={legend}
                    fmt={fmtUsdLevel}
                    dust
                  />
                )}
                {hasRevenue && (
                  <CohortTd
                    cell={cohortCell(r.inFeesCohort, r.revenue30d, r.revenue30dOutside, r.notApplicable.fees ?? null)}
                    legend={legend}
                    fmt={fmtUsdLevel}
                    dust
                  />
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <NaLegend entries={legend} />
    </div>
  );
}

/**
 * Net USDC over Circle CCTP on the chains bench 281 scans as sources. Its own
 * block rather than a column, because seven rows of real numbers say more than
 * sixty-three rows where seven carry a figure. The caveat is the same one the
 * page's Sources section makes: one bridge's ledger, not total cross-chain flow.
 */
function CctpTable({ rows }: { rows: ChainRow[] }) {
  const { sorted, key, dir, toggle } = useSorted(rows, "cctpNet7d", "desc", chainSortValue);
  const col = (k: keyof ChainRow, label: string, title?: string) => (
    <ThSort active={key === k} dir={dir} onClick={() => toggle(k)} title={title}>
      {label}
    </ThSort>
  );
  return (
    <div className="mt-8">
      <h3 className="label-mono text-ink-muted mb-3">Net USDC over Circle CCTP, 7 days, on the {rows.length} chains the bench scans as sources</h3>
      <div className="card-soft rounded-xl border border-ink/10 max-w-3xl">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="bg-paper-soft/60 text-left">
                <Th>#</Th>
                <Th>Chain</Th>
                {col("cctpNet7d", "Net 7d", "USDC that arrived over CCTP minus USDC that left, 7 days")}
                {col("cctpIn7d", "In 7d", "USDC minted on this chain against a burn elsewhere")}
                {col("cctpOut7d", "Out 7d", "USDC burned on this chain to be minted elsewhere")}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.slug} className="border-t border-ink/5 hover:bg-paper-soft/40 transition-colors">
                  <Td muted mono>
                    {i + 1}
                  </Td>
                  <Td>
                    {r.hasChainPage ? (
                      <Link href={`/chains/${r.slug}`} className="flex items-center gap-2 min-w-0 hover:underline whitespace-nowrap">
                        <ProviderLogo slug={r.slug} name={r.name} size={18} />
                        <span className="font-medium text-ink">{r.name}</span>
                      </Link>
                    ) : (
                      <span className="flex items-center gap-2 min-w-0 whitespace-nowrap">
                        <ProviderLogo slug={r.slug} name={r.name} size={18} />
                        <span className="font-medium text-ink">{r.name}</span>
                      </span>
                    )}
                  </Td>
                  <Td mono>
                    <Signed v={r.cctpNet7d} fmt={(v) => fmtUsdShort(v)} />
                  </Td>
                  <Td mono>{fmtUsdShort(r.cctpIn7d)}</Td>
                  <Td mono>{fmtUsdShort(r.cctpOut7d)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-3 py-2 text-[11px] text-ink-faint leading-relaxed">
          Circle CCTP burn and mint events read from public RPCs, bench{" "}
          <Link href={`/benchmarks/${CAPITAL_BENCHES.usdcCorridor}`} className="hover:underline">
            {CAPITAL_BENCHES.usdcCorridor}
          </Link>
          . One bridge&apos;s ledger over one stablecoin, not total cross-chain flow: the Net stables 30d column above is the bridge-agnostic
          reading, and a chain absent here either has no CCTP domain or is not scanned as a source.
        </p>
      </div>
    </div>
  );
}

function FlowBar({ shares }: { shares: { slug: string; name: string; usd: number; pct: number }[] }) {
  const palette = ["#7a2e1f", "#c2410c", "#b45309", "#4d7c0f", "#0f766e", "#1d4ed8", "#6d28d9", "#be185d", "#475569", "#a16207"];
  return (
    <div className="mt-6">
      <p className="label-mono text-[10px] uppercase tracking-wide text-ink-faint mb-2" style={{ fontFamily: "var(--font-mono, monospace)" }}>
        Where the stablecoin inflows went over 30 days (chains with a net inflow)
      </p>
      <div className="flex h-3 w-full overflow-hidden rounded-sm bg-paper-soft">
        {shares.slice(0, 10).map((c, i) => (
          <span key={c.slug} title={`${c.name}: ${fmtUsdShort(c.usd)} (${c.pct.toFixed(1)}%)`} style={{ width: `${c.pct}%`, background: palette[i % palette.length] }} />
        ))}
      </div>
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-soft">
        {shares.slice(0, 8).map((c, i) => (
          <span key={c.slug} className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2 w-2 rounded-sm" style={{ background: palette[i % palette.length] }} />
            {c.name} {c.pct.toFixed(1)}%
          </span>
        ))}
      </p>
    </div>
  );
}

/**
 * Open interest with the two columns that make it a reading rather than a
 * level: 24h volume and turnover, the number of times the venue traded its
 * open interest in a day. A venue outside a source cohort reads "not
 * applicable" with the reason; no cell is ever filled from a neighbouring
 * venue or from a cohort-level figure.
 */
function OiTable({
  title,
  rows,
  link,
  benches,
  note,
}: {
  title: string;
  rows: OiRow[];
  link: (slug: string) => string;
  benches: string[];
  note: string;
}) {
  // Every row, not a top ten: a reader who counts ten rows on a table of
  // nineteen concludes the rest is missing, which is exactly what happened.
  // The heading carries the count so the table says how long it is.
  const has7d = columnIsWorthShowing(rows, (r) => r.change7dPct);
  const hasVolume = columnIsWorthShowing(rows, (r) => r.volume24h);
  const hasTurnover = columnIsWorthShowing(rows, (r) => r.turnover);
  const legend = naLegend([
    ...rows.map((r) => r.oiNaReason),
    ...(has7d ? rows.map((r) => r.change7dNaReason) : []),
    ...(hasVolume ? rows.map((r) => r.volumeNaReason) : []),
    ...(hasTurnover ? rows.map((r) => r.turnoverNaReason) : []),
  ]);
  return (
    <div className="card-soft rounded-xl border border-ink/10">
      <p className="px-3 pt-3 label-mono text-[10px] uppercase tracking-wide text-ink-faint" style={{ fontFamily: "var(--font-mono, monospace)" }}>
        {title}, all {rows.length}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px] mt-2">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <Th>Venue</Th>
              <Th>Open interest</Th>
              {has7d && <Th title="Change of open interest over seven days">7d</Th>}
              {hasVolume && <Th title="Traded notional over the trailing 24 hours, from the venue's own API">Volume 24h</Th>}
              {hasTurnover && (
                <Th title="Times the venue traded its own open interest in 24 hours: 24h volume over open interest, both as the venue's API reports them">
                  Turnover 24h
                </Th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.slug} className="border-t border-ink/5">
                <Td muted mono>
                  {i + 1}
                </Td>
                <Td>
                  <Link href={link(r.slug)} className="flex items-center gap-2 hover:underline whitespace-nowrap">
                    <ProviderLogo slug={r.slug} name={r.name} size={16} />
                    <span className="text-ink">{r.name}</span>
                  </Link>
                </Td>
                <CohortTd cell={plainCell(r.oi, r.oiNaReason)} legend={legend} fmt={fmtUsdShort} />
                {has7d && (
                  <CohortTd cell={plainCell(r.change7dPct, r.change7dNaReason)} legend={legend} signed fmt={(v) => fmtPct(v)} />
                )}
                {hasVolume && <CohortTd cell={plainCell(r.volume24h, r.volumeNaReason)} legend={legend} fmt={fmtUsdShort} />}
                {/* No outlier guard on turnover, deliberately: Gains reads far
                    above every other row because its positions turn over in
                    under half an hour, and that is the most informative cell
                    on the table. Bench 271 publishes it unclipped too. */}
                {hasTurnover && <CohortTd cell={plainCell(r.turnover, r.turnoverNaReason)} legend={legend} fmt={fmtX} />}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <NaLegend entries={legend} />
      <p className="px-3 pb-2 text-[11px] text-ink-faint">{note}</p>
      <p className="px-3 pb-2 text-[11px] text-ink-faint flex flex-wrap gap-x-3">
        {benches.map((b) => (
          <Link key={b} href={`/benchmarks/${b}`} className="hover:underline">
            Bench {b}
          </Link>
        ))}
      </p>
    </div>
  );
}

/** The protocol_diverging rows, five largest fee growth first; an empty state sentence when none. */
function Divergences({ rows }: { rows: ProtocolRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-soft">
        No token clears all four conditions today: 30-day fees up more than {SIGNAL_FEE_GROWTH_MIN_PCT}% against the prior 30 days, the token down
        more than {SIGNAL_PRICE_MOVE_MIN_PCT}% over the same days, price to fees under the category median, and at least{" "}
        {SIGNAL_MIN_CATEGORY_MEMBERS} ranked protocols in the category. The badges in the table below mark the rows that clear them as the month moves.
      </p>
    );
  }
  return (
    <div className="card-soft rounded-xl border border-ink/10">
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>Token</Th>
              <Th>Category</Th>
              <Th>Fees MoM</Th>
              <Th>Token 30d</Th>
              <Th>P/F vs median</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.slug} className="border-t border-ink/5">
                <Td>
                  <NameCell slug={r.slug} name={r.name} link={r.hasProductPage ? `/products/${r.slug}` : null} />
                </Td>
                <Td>
                  <span className="text-[11px] text-ink-soft">{r.category || "n/a"}</span>
                </Td>
                <Td mono>
                  <Signed v={r.feeGrowth30dPct} fmt={(v) => fmtPct(v, 0)} />
                </Td>
                <Td mono>
                  <Signed v={r.priceChange30dPct} fmt={(v) => fmtPct(v, 0)} />
                </Td>
                <Td mono>
                  <span title={signalRowNote(r) ?? undefined}>
                    {fmtX(r.pf)} vs {fmtX(r.categoryMedianPf)}
                  </span>
                  <Sub>{fmtX(r.pfVsCategory)} of the {r.category || "category"} median</Sub>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-3 py-2 text-[11px] text-ink-faint">
        Four conditions at once on bench {CAPITAL_BENCHES.protocolPf}: fees up more than {SIGNAL_FEE_GROWTH_MIN_PCT}% against the prior 30 days, the
        token down more than {SIGNAL_PRICE_MOVE_MIN_PCT}% over the same days, price to fees under the category median, and the category holding at
        least {SIGNAL_MIN_CATEGORY_MEMBERS} ranked protocols. A screen for further reading, not a signal to act on.
      </p>
    </div>
  );
}

function ProtocolsTable({ rows }: { rows: ProtocolRow[] }) {
  const { sorted, key, dir, toggle } = useSorted(rows, "pf", "asc");
  const [q, setQ] = useState("");
  const [onlySignal, setOnlySignal] = useState(false);
  // Columns the protocol-valuation harness adds next: hidden while no row carries a value.
  const hasPs = columnIsWorthShowing(rows, (r) => r.ps);
  const hasSupply = columnIsWorthShowing(rows, (r) => r.supplyChange30dPct);
  const hasTvl = columnIsWorthShowing(rows, (r) => r.tvl);
  const hasRevenue = columnIsWorthShowing(rows, (r) => r.revenue30d);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sorted.filter(
      (r) =>
        (!onlySignal || r.signal !== null) &&
        (!needle || r.name.toLowerCase().includes(needle) || r.slug.includes(needle) || r.category.toLowerCase().includes(needle)),
    );
  }, [sorted, q, onlySignal]);
  const col = (k: keyof ProtocolRow, label: string, title?: string, defaultDir: "desc" | "asc" = "desc") => (
    <ThSort active={key === k} dir={dir} onClick={() => toggle(k, defaultDir)} title={title}>
      {label}
    </ThSort>
  );
  const colCount = 9 + [hasPs, hasSupply, hasTvl, hasRevenue].filter(Boolean).length;
  // A category with too few ranked members has no usable median: the cell
  // says so instead of printing a ratio against one or two protocols.
  const protocolLegend = naLegend(rows.map((r) => r.pfVsCategoryNaReason));
  return (
    <div className="card-soft rounded-xl border border-ink/10">
      <div className="p-3 sm:p-4 border-b border-ink/8 flex items-center justify-between gap-3 flex-wrap">
        <label className="inline-flex items-center gap-2 text-[12px] text-ink-soft">
          <input type="checkbox" checked={onlySignal} onChange={(e) => setOnlySignal(e.target.checked)} />
          Only rows where fees and token moved apart
        </label>
        <input
          type="search"
          aria-label="Search protocols"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search protocol or category"
          className="text-[12.5px] px-3 py-1.5 rounded-md border border-ink/15 bg-paper focus:outline-none focus:ring-2 focus:ring-ink/15 min-w-[200px]"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <Th>Token</Th>
              <Th>Category</Th>
              {col("pf", "P/F", "Market cap over annualized fees (30 days times 365/30, DeFiLlama)", "asc")}
              {col("pfFdv", "FDV/F", "Fully diluted valuation over annualized fees", "asc")}
              {hasPs && col("ps", "P/S", "Market cap over annualized revenue, the protocol's own share of the fees", "asc")}
              {col("floatPct", "Float", "Circulating over total supply (CoinGecko)")}
              {hasSupply && col("supplyChange30dPct", "Supply 30d", "Change in circulating supply over 30 days: the dilution that already happened")}
              {col("feeGrowth30dPct", "Fees MoM", "30-day fees against the prior 30 days")}
              {col("priceChange30dPct", "Token 30d", "Token price change over 30 days")}
              {col("pfVsCategory", "vs category", "P/F over the fee-weighted category median; below 1 is under the median", "asc")}
              {hasTvl && col("tvl", "TVL", "Value locked in the protocol's contracts (DeFiLlama)")}
              {hasRevenue && col("revenue30d", "Revenue 30d", "The part of 30-day fees the protocol kept (DeFiLlama dailyRevenue)")}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={r.slug} className="border-t border-ink/5 hover:bg-paper-soft/40 transition-colors">
                <Td muted mono>
                  {i + 1}
                </Td>
                <Td>
                  <NameCell slug={r.slug} name={r.name} link={r.hasProductPage ? `/products/${r.slug}` : null} />
                </Td>
                <Td>
                  <span className="text-[11px] text-ink-soft">{r.category || "n/a"}</span>
                </Td>
                <Td mono>{fmtX(r.pf)}</Td>
                <Td mono>{fmtX(r.pfFdv)}</Td>
                {hasPs && <Td mono>{fmtX(r.ps)}</Td>}
                <Td mono>{r.floatPct != null ? `${r.floatPct.toFixed(0)}%` : "n/a"}</Td>
                {hasSupply && (
                  <Td mono>
                    <Signed v={r.supplyChange30dPct} fmt={(v) => fmtPct(v)} plain />
                  </Td>
                )}
                <Td mono>
                  <Signed v={r.feeGrowth30dPct} fmt={(v) => fmtPct(v, 0)} />
                </Td>
                <Td mono>
                  <Signed v={r.priceChange30dPct} fmt={(v) => fmtPct(v, 0)} />
                </Td>
                {r.pfVsCategoryNaReason ? (
                  <NaTd reason={r.pfVsCategoryNaReason} legend={protocolLegend} />
                ) : (
                <Td mono>
                  {fmtX(r.pfVsCategory)}
                  {r.signal === "fees-up-token-down" && (
                    <Badge tone="up" title={signalRowNote(r) ?? undefined}>
                      fees up, token down
                    </Badge>
                  )}
                  {r.signal === "fees-down-token-up" && (
                    <Badge tone="down" title={signalRowNote(r) ?? undefined}>
                      fees down, token up
                    </Badge>
                  )}
                </Td>
                )}
                {hasTvl && <Td mono>{fmtUsdShort(r.tvl)}</Td>}
                {hasRevenue && (
                  <Td mono muted={r.revenueIncomplete}>
                    {r.revenue30d != null && r.revenueIncomplete ? (
                      <span title="Revenue total knowably short: a revenue adapter reports nothing this month, so the figure covers part of the protocol and no P/S is built on it">
                        {fmtUsdShort(r.revenue30d)}*
                      </span>
                    ) : (
                      fmtUsdShort(r.revenue30d)
                    )}
                  </Td>
                )}
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-3 py-8 text-center text-[12px] text-ink-faint">
                  No row matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <NaLegend entries={protocolLegend} />
    </div>
  );
}

function PerpsTable({ rows }: { rows: PerpRow[] }) {
  const { sorted, key, dir, toggle } = useSorted(rows, "pf", "asc");
  const col = (k: keyof PerpRow, label: string, title?: string, defaultDir: "desc" | "asc" = "desc") => (
    <ThSort active={key === k} dir={dir} onClick={() => toggle(k, defaultDir)} title={title}>
      {label}
    </ThSort>
  );
  return (
    <div className="card-soft rounded-xl border border-ink/10">
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <Th>Venue</Th>
              {col("pf", "P/F", "Market cap over annualized fees", "asc")}
              {col("ps", "P/S", "Market cap over annualized revenue (the protocol's share of fees)", "asc")}
              {col("pfFdv", "FDV/F", "Fully diluted valuation over annualized fees", "asc")}
              {col("mcap", "Market cap")}
              {col("fdv", "FDV")}
              {col("floatPct", "Float", "Circulating over total supply")}
              {col("oi", "Open interest")}
              {col("fees30d", "Fees 30d")}
              {col("rev30d", "Revenue 30d")}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={r.slug} className="border-t border-ink/5 hover:bg-paper-soft/40 transition-colors">
                <Td muted mono>
                  {i + 1}
                </Td>
                <Td>
                  <NameCell slug={r.slug} name={r.name} link={r.hasProductPage ? `/products/${r.slug}` : null} />
                </Td>
                <Td mono>{fmtX(r.pf)}</Td>
                <Td mono>{fmtX(r.ps)}</Td>
                <Td mono>{fmtX(r.pfFdv)}</Td>
                <Td mono>{fmtUsdShort(r.mcap)}</Td>
                <Td mono>{fmtUsdShort(r.fdv)}</Td>
                <Td mono>{r.floatPct != null ? `${r.floatPct.toFixed(0)}%` : "n/a"}</Td>
                <Td mono>{fmtUsdShort(r.oi)}</Td>
                <Td mono>{fmtUsdShort(r.fees30d)}</Td>
                <Td mono>{fmtUsdShort(r.rev30d)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** Three lines under a table: how to read the main column, the pitfall, what the table does not say. */
function Reading({ lines }: { lines: readonly string[] }) {
  return (
    <ul className="mt-3 max-w-3xl space-y-1 text-[12px] text-ink-soft leading-relaxed list-disc pl-5">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

function NameCell({ slug, name, link }: { slug: string; name: string; link: string | null }) {
  const inner = (
    <>
      <ProviderLogo slug={slug} name={name} size={18} />
      <span className="font-medium text-ink">{name}</span>
    </>
  );
  return link ? (
    <Link href={link} className="flex items-center gap-2 min-w-0 hover:underline whitespace-nowrap">
      {inner}
    </Link>
  ) : (
    <span className="flex items-center gap-2 min-w-0 whitespace-nowrap">{inner}</span>
  );
}

/** A DeFiLlama level: a muted "n/a" when missing, a muted "<$1K" under the dust floor (a zero for an untracked chain, not a measurement). */
function Level({ v }: { v: number | null }) {
  if (v == null) return <Unknown />;
  if (isDust(v)) return <span className="text-ink-faint" title="Under $1,000: DeFiLlama reports zero for a chain it does not track">{fmtUsdLevel(v)}</span>;
  return <>{fmtUsdShort(v)}</>;
}

function Signed({ v, fmt, plain }: { v: number | null; fmt: (v: number) => string; plain?: boolean }) {
  if (v == null) return <Unknown />;
  const color = plain ? undefined : v > 0 ? "var(--color-good)" : v < 0 ? "var(--color-bad, #e5484d)" : undefined;
  return <span style={color ? { color } : undefined}>{fmt(v)}</span>;
}

/**
 * The four states in one cell (src/lib/capital-hub-rules.ts):
 *  - value: ranked, plain;
 *  - outside: the daily history's number for a row the bench does not rank,
 *    muted and labelled;
 *  - na: does not apply, printed as a dash carrying the superscript marker
 *    that ties it to the reason in the legend under the table;
 *  - unknown: "n/a" and nothing else, the same thing "n/a" means on every
 *    other page of the site.
 * A reader tells the last two apart without a mouse by the letter: a marked
 * dash against a plain "n/a".
 */
function CohortTd({
  cell,
  fmt,
  legend,
  signed,
  sub,
  dust,
}: {
  cell: CohortCell;
  fmt: (v: number) => string;
  legend: readonly { marker: string; reason: string }[];
  signed?: boolean;
  sub?: string | null;
  dust?: boolean;
}) {
  if (cell.kind === "unknown")
    return (
      <Td mono>
        <Unknown />
      </Td>
    );
  if (cell.kind === "na") return <NaTd reason={cell.reason} legend={legend} />;
  if (cell.kind === "outside") {
    return (
      <td className="px-3 py-2 tabular-nums whitespace-nowrap text-ink-faint" style={{ fontFamily: "var(--font-mono, monospace)" }} aria-label={OUTSIDE_COHORT_LABEL} title={OUTSIDE_COHORT_LABEL}>
        {fmt(cell.value)}
      </td>
    );
  }
  return (
    <Td mono>
      {signed ? <Signed v={cell.value} fmt={fmt} /> : dust ? <Level v={cell.value} /> : fmt(cell.value)}
      {sub && <Sub>{sub}</Sub>}
    </Td>
  );
}

/** The feed carries no value for this row this run: "n/a", the same as everywhere else on the site. */
function Unknown() {
  return (
    <span className="text-ink-faint" title={UNKNOWN_LABEL} aria-label={UNKNOWN_LABEL}>
      n/a
    </span>
  );
}

/** The column does not apply to this row: a dash carrying the marker that names the reason in the legend. */
function NaTd({ reason, legend }: { reason: string | undefined; legend: readonly { marker: string; reason: string }[] }) {
  if (!reason)
    return (
      <Td mono>
        <Unknown />
      </Td>
    );
  return (
    <td
      className="px-3 py-2 whitespace-nowrap text-ink-faint/70"
      style={{ fontFamily: "var(--font-mono, monospace)" }}
      title={`Not applicable: ${reason}`}
      aria-label={`Not applicable: ${reason}`}
    >
      -<sup className="ml-px text-[10px] font-medium">{naMarker(legend, reason)}</sup>
    </td>
  );
}

/** One line under a table: what a marked dash means, what each marker means, and what a plain "n/a" means. */
function NaLegend({ entries }: { entries: readonly { marker: string; reason: string }[] }) {
  if (entries.length === 0) return null;
  return (
    <p className="px-3 py-2 text-[11px] text-ink-faint leading-relaxed">
      A dash with a letter, like <span className="text-ink-soft">-{entries[0].marker}</span>, means {NOT_APPLICABLE_LABEL}.{" "}
      {entries.map((e) => `${e.marker}: ${e.reason}`).join(". ")}. A plain <span className="text-ink-soft">n/a</span> is a different thing:{" "}
      {UNKNOWN_LABEL}.
    </p>
  );
}

/**
 * What each signal implies, what would falsify it, what to check next. Three
 * lines per signal, under the divergence table where the badges are read.
 * The text lives in src/lib/capital-hub-rules.ts and the Markdown view
 * prints the same words.
 */
function SignalReadings({ counts }: { counts: Record<SignalKind, number> }) {
  const kinds: SignalKind[] = ["fees-up-token-down", "fees-down-token-up"];
  return (
    <div className="mt-4 max-w-3xl space-y-4">
      {kinds.map((k) => (
        <div key={k}>
          <p className="text-[12.5px] font-medium text-ink">
            {SIGNAL_READING[k].title}{" "}
            <span className="text-ink-faint font-normal">
              ({counts[k]} {counts[k] === 1 ? "token" : "tokens"} today)
            </span>
          </p>
          <ul className="mt-1 space-y-1 text-[12px] text-ink-soft leading-relaxed list-disc pl-5">
            <li>
              <span className="text-ink-muted">What it means.</span> {SIGNAL_READING[k].means}
            </li>
            <li>
              <span className="text-ink-muted">What would falsify it.</span> {SIGNAL_READING[k].falsifies}
            </li>
            <li>
              <span className="text-ink-muted">What to check next.</span> {SIGNAL_READING[k].next}
            </li>
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The signal marker, carrying the row's own reading in its title: the three numbers, then the one thing that would change it. */
function Badge({ children, tone, title }: { children: React.ReactNode; tone: "up" | "down"; title?: string }) {
  return (
    <span
      title={title}
      className="ml-1 inline-block rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide align-middle"
      style={{
        background: tone === "up" ? "color-mix(in srgb, var(--color-good) 15%, transparent)" : "color-mix(in srgb, var(--color-bad, #e5484d) 15%, transparent)",
        color: tone === "up" ? "var(--color-good)" : "var(--color-bad, #e5484d)",
      }}
    >
      {children}
    </span>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return <span className="block text-[10px] text-ink-faint">{children}</span>;
}

function Th({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <th
      className="px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide text-ink-faint whitespace-nowrap"
      style={{ fontFamily: "var(--font-mono, monospace)" }}
      title={title}
    >
      {children}
    </th>
  );
}

function ThSort({ children, active, dir, onClick, title }: { children: React.ReactNode; active: boolean; dir: "asc" | "desc"; onClick: () => void; title?: string }) {
  return (
    <th
      className={`px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide cursor-pointer select-none whitespace-nowrap ${active ? "text-ink" : "text-ink-faint hover:text-ink"}`}
      style={{ fontFamily: "var(--font-mono, monospace)" }}
      onClick={onClick}
      title={title}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <span className="text-[9px]">{active ? (dir === "desc" ? "▼" : "▲") : "⇅"}</span>
      </span>
    </th>
  );
}

function Td({ children, mono, muted }: { children: React.ReactNode; mono?: boolean; muted?: boolean }) {
  return (
    <td className={`px-3 py-2 tabular-nums whitespace-nowrap ${muted ? "text-ink-faint" : ""}`} style={mono ? { fontFamily: "var(--font-mono, monospace)" } : undefined}>
      {children}
    </td>
  );
}
