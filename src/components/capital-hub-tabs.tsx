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
  CCTP_SCOPE_LABEL,
  OUTSIDE_COHORT_LABEL,
  bridgedShareSubline,
  cohortCell,
  fmtUsdLevel,
  isDust,
  levelSortValue,
  sevenDaySubline,
  type CohortCell,
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
          {(hub.perpOi.length > 0 || hub.pmOi.length > 0) && (
            <>
              <h2 className="label-mono text-ink-muted mt-10 mb-3">Open interest: perp DEXes and prediction markets</h2>
              <div className="grid gap-6 lg:grid-cols-2">
                {hub.perpOi.length > 0 && (
                  <OiTable title="Perp DEX open interest" rows={hub.perpOi} link={(s) => `/products/${s}`} bench={CAPITAL_BENCHES.perpPf} />
                )}
                {hub.pmOi.length > 0 && (
                  <OiTable title="Prediction market open interest" rows={hub.pmOi} link={(s) => `/products/${s}`} bench={CAPITAL_BENCHES.pmOi} showVolume />
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
  // Columns fed by the daily history blob stay hidden until it carries
  // values, instead of a wall of n/a on the first days.
  const hasTvl = rows.some((r) => r.tvl != null);
  const hasDex = rows.some((r) => r.dexVolume24h != null);
  const hasFees = rows.some((r) => r.fees30d != null || r.fees30dOutside != null);
  const hasCctp = rows.some((r) => r.cctpNet7d != null);
  const { sorted, key, dir, toggle } = useSorted(rows, hasTvl ? "tvl" : "stablesFloat", "desc", chainSortValue);
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
              {col("bridgedTvl", "Bridged value", "Value secured that arrived from another chain, canonical plus external (L2Beat)")}
              {col("excess7dPct", "7d vs L2 median", "Weekly move of value secured minus the median move across L2Beat projects above $200M")}
              {col("stablesFloat", "Stablecoin float", "Pegged-USD circulating on the chain, every issuer (DeFiLlama)")}
              {col("stablesNet30d", "Net stables 30d", "Dollar change of the stablecoin float over 30 days; muted for a chain outside the ranked cohort")}
              {hasCctp && col("cctpNet7d", "USDC over CCTP 7d", "Net USDC that entered the chain over Circle CCTP in 7 days, burn events on seven EVM chains (bench 281); a dash for a chain the bench does not scan")}
              {hasDex && col("dexVolume24h", "DEX volume 24h", "DEX volume on the chain over the trailing 24 hours (DeFiLlama)")}
              {hasFees && col("fees30d", "Fees 30d", "Fees users paid on the chain over 30 closed days: gas plus every protocol DeFiLlama tracks on it (bench 280); muted for a chain outside the ranked cohort")}
              {hasFees && col("revenue30d", "Revenue 30d", "Revenue the chain and its protocols kept out of those fees, per each DeFiLlama adapter")}
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
                {/* L1s are outside the L2Beat cohort: a dash, so n/a keeps meaning missing data. */}
                {r.inBridgedCohort ? (
                  <Td mono>
                    {fmtUsdShort(r.bridgedTvl)}
                    {bridgedShareSubline(r.bridgedSharePct) && <Sub>{bridgedShareSubline(r.bridgedSharePct)}</Sub>}
                  </Td>
                ) : (
                  <Dash label="not applicable" />
                )}
                {r.inBridgedCohort ? (
                  <Td mono>
                    <Signed v={r.excess7dPct} fmt={(v) => fmtPct(v)} />
                    {sevenDaySubline(r.change7dPct, r.median7dPct) && <Sub>{sevenDaySubline(r.change7dPct, r.median7dPct)}</Sub>}
                  </Td>
                ) : (
                  <Dash label="not applicable" />
                )}
                <Td mono>
                  <Level v={r.stablesFloat} />
                </Td>
                <CohortTd
                  cell={cohortCell(r.inStablesCohort, r.stablesNet30d, r.stablesNet30dOutside)}
                  signed
                  fmt={fmtUsdShort}
                  sub={r.stablesChange30dPct != null ? fmtPct(r.stablesChange30dPct) : null}
                />
                {hasCctp &&
                  (r.cctpScope === "scanned" ? (
                    <Td mono>
                      <Signed v={r.cctpNet7d} fmt={(v) => fmtUsdShort(v)} />
                      {r.cctpIn7d != null && r.cctpOut7d != null && (
                        <Sub>
                          in {fmtUsdShort(r.cctpIn7d)} / out {fmtUsdShort(r.cctpOut7d)}
                        </Sub>
                      )}
                    </Td>
                  ) : (
                    <Dash label={CCTP_SCOPE_LABEL[r.cctpScope]} />
                  ))}
                {hasDex && (
                  <Td mono>
                    <Level v={r.dexVolume24h} />
                  </Td>
                )}
                {hasFees && <CohortTd cell={cohortCell(r.inFeesCohort, r.fees30d, r.fees30dOutside)} fmt={fmtUsdLevel} dust />}
                {hasFees && <CohortTd cell={cohortCell(r.inFeesCohort, r.revenue30d, r.revenue30dOutside)} fmt={fmtUsdLevel} dust />}
              </tr>
            ))}
          </tbody>
        </table>
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

function OiTable({ title, rows, link, bench, showVolume }: { title: string; rows: OiRow[]; link: (slug: string) => string; bench: string; showVolume?: boolean }) {
  const shown = rows.slice(0, 10);
  const has7d = shown.some((r) => r.change7dPct != null);
  return (
    <div className="card-soft rounded-xl border border-ink/10">
      <p className="px-3 pt-3 label-mono text-[10px] uppercase tracking-wide text-ink-faint" style={{ fontFamily: "var(--font-mono, monospace)" }}>
        {title}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px] mt-2">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <Th>Venue</Th>
              <Th>Open interest</Th>
              {has7d && <Th>7d</Th>}
              {showVolume && <Th>Volume 24h</Th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
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
                <Td mono>{fmtUsdShort(r.oi)}</Td>
                {/* Empty, not n/a: the window is not covered yet, nothing is missing from the bench. */}
                {has7d && <Td mono>{r.change7dPct != null ? <Signed v={r.change7dPct} fmt={(v) => fmtPct(v)} /> : ""}</Td>}
                {showVolume && <Td mono>{fmtUsdShort(r.volume24h)}</Td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-3 py-2 text-[11px] text-ink-faint">
        <Link href={`/benchmarks/${bench}`} className="hover:underline">
          Bench {bench}
        </Link>
      </p>
    </div>
  );
}

/** The protocol_diverging rows, five largest fee growth first; an empty state sentence when none. */
function Divergences({ rows }: { rows: ProtocolRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-soft">
        No token has its 30-day fees up against the prior 30 days, its price down over 30 days and its price to fees under the category median today.
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
                  {fmtX(r.pf)} vs {fmtX(r.categoryMedianPf)}
                  <Sub>{fmtX(r.pfVsCategory)} of the {r.category || "category"} median</Sub>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-3 py-2 text-[11px] text-ink-faint">
        Three conditions at once, read from bench {CAPITAL_BENCHES.protocolPf}. A screen for further reading, not a signal to act on.
      </p>
    </div>
  );
}

function ProtocolsTable({ rows }: { rows: ProtocolRow[] }) {
  const { sorted, key, dir, toggle } = useSorted(rows, "pf", "asc");
  const [q, setQ] = useState("");
  const [onlySignal, setOnlySignal] = useState(false);
  // Columns the protocol-valuation harness adds next: hidden while no row carries a value.
  const hasPs = rows.some((r) => r.ps != null);
  const hasSupply = rows.some((r) => r.supplyChange30dPct != null);
  const hasTvl = rows.some((r) => r.tvl != null);
  const hasRevenue = rows.some((r) => r.revenue30d != null);
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
                <Td mono>
                  {fmtX(r.pfVsCategory)}
                  {r.signal === "fees-up-token-down" && <Badge tone="up">fees up, token down</Badge>}
                  {r.signal === "fees-down-token-up" && <Badge tone="down">fees down, token up</Badge>}
                </Td>
                {hasTvl && <Td mono>{fmtUsdShort(r.tvl)}</Td>}
                {hasRevenue && <Td mono>{fmtUsdShort(r.revenue30d)}</Td>}
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

/** A DeFiLlama level: n/a when missing, a muted "<$1K" under the dust floor (a zero for an untracked chain, not a measurement). */
function Level({ v }: { v: number | null }) {
  if (v == null) return <span className="text-ink-faint">n/a</span>;
  if (isDust(v)) return <span className="text-ink-faint" title="Under $1,000: DeFiLlama reports zero for a chain it does not track">{fmtUsdLevel(v)}</span>;
  return <>{fmtUsdShort(v)}</>;
}

function Signed({ v, fmt, plain }: { v: number | null; fmt: (v: number) => string; plain?: boolean }) {
  if (v == null) return <span className="text-ink-faint">n/a</span>;
  const color = plain ? undefined : v > 0 ? "var(--color-good)" : v < 0 ? "var(--color-bad, #e5484d)" : undefined;
  return <span style={color ? { color } : undefined}>{fmt(v)}</span>;
}

/**
 * A cell of a bench-ranked column: the ranked value (signed or level), n/a
 * inside the cohort with no value, the blob value muted and labelled
 * outside the cohort, a dash when nothing exists for the row.
 */
function CohortTd({ cell, fmt, signed, sub, dust }: { cell: CohortCell; fmt: (v: number) => string; signed?: boolean; sub?: string | null; dust?: boolean }) {
  if (cell.kind === "dash") return <Dash label="not applicable" />;
  if (cell.kind === "na") return <Td mono>{<span className="text-ink-faint">n/a</span>}</Td>;
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

function Badge({ children, tone }: { children: React.ReactNode; tone: "up" | "down" }) {
  return (
    <span
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

/** Not applicable to this row (outside the bench's cohort, no CCTP domain), as opposed to n/a for missing data. */
function Dash({ label }: { label: string }) {
  return (
    <td className="px-3 py-2 text-ink-faint/60 text-center" aria-label={label} title={label}>
      -
    </td>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return <span className="block text-[10px] text-ink-faint">{children}</span>;
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide text-ink-faint whitespace-nowrap" style={{ fontFamily: "var(--font-mono, monospace)" }}>
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
