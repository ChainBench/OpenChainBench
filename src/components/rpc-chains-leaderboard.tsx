"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { THIN_RPC_MIN_RESULTS } from "@/lib/provider-filters";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import { Sparkline } from "@/components/sparkline";
import {
  RPC_REGION_KEYS,
  RPC_REGION_LABELS,
  type RpcHubChain,
  type RpcRegionKey,
} from "@/lib/rpc-hub-shape";

/**
 * Sortable + searchable chain matrix for /rpc. One row per `-rpc`
 * bench: fastest provider overall (highlighted), fastest per probe
 * region (US-East / EU-West / Singapore), live provider count and the
 * leader's 24h latency sparkline. Rows link to the per-chain bench
 * page where the full leaderboard + region tabs live.
 *
 * Data is pure SSR input; this component only owns sort + search state.
 */

type SortKey =
  | "name"
  | "bestP50"
  | "bestP90"
  | "bestP95"
  | "archive"
  | "us-east"
  | "eu-west"
  | "sgp"
  | "providerCount";

const ALL_REGION_COLS: { key: RpcRegionKey; label: string }[] =
  RPC_REGION_KEYS.map((key) => ({ key, label: RPC_REGION_LABELS[key] }));

function sortValue(r: RpcHubChain, k: SortKey): number | string | null {
  if (k === "name") return r.name.toLowerCase();
  if (k === "bestP50") return r.best?.p50Ms ?? null;
  if (k === "bestP90") return r.bestP90Ms ?? null;
  if (k === "bestP95") return r.bestP95Ms ?? null;
  if (k === "archive") return r.bestArchiveDepthBlocks ?? null;
  if (k === "providerCount") return r.providerCount;
  return r.regions[k]?.p50Ms ?? null;
}

/** Rows rendered before "Show all": 152 chains at about 4 KB of markup
 *  each (sparkline SVG, logos, links) made /rpc a 1 MB document
 *  (2026-09-19). The full list of chain pages is still in the HTML as a
 *  compact nav on the page, so crawlers lose no link. */
const INITIAL_ROWS = 40;

export function RpcChainsLeaderboard({
  rows,
  linkableSlugs,
  benchQuery = "",
  regions,
  bestLabel = "Best overall (3-region avg)",
  bestTip = "Lowest p50 averaged across the 3 probe regions. A provider can win overall without winning any single region: consistent everywhere beats fast in one region, slow elsewhere.",
  scopeNote = "3 probe regions",
  geoControl,
  raceMode = false,
}: {
  rows: RpcHubChain[];
  /** Bench slugs whose page is indexable (worker sitemap). When given it
   *  replaces the declared-count gate, so an expired chain (data older
   *  than a week, noindex) is shown but not linked. */
  linkableSlugs?: string[];
  /** Suffix appended to every bench link ("#tier=keyed" on the
   *  API-key view, so the row opens the cohort it ranks). */
  benchQuery?: string;
  /** Which per-region winner columns to draw. The geo view passes an
   *  empty list: its rows already hold one region's numbers, so the
   *  column would repeat the Best column. Default is all three. */
  regions?: RpcRegionKey[];
  /** Heading and tooltip of the leading latency column, which stops
   *  being a 3-region average once the geo view scopes the rows. */
  bestLabel?: string;
  bestTip?: string;
  /** Tail of the caption above the table, which claimed three regions
   *  whatever the rows held. */
  scopeNote?: string;
  /** The hub's region selector, rendered in this table's header bar. The
   *  state belongs to the hub (both tables are scoped by it); only the
   *  placement is ours, beside the caption that names the scope. */
  geoControl?: React.ReactNode;
  /** The block-push cohort is a race, not a latency: every leader reads 0
   *  because it is zero behind itself. Under this flag the leading cell
   *  shows the margin over the runner-up, which is the figure that carries
   *  information, instead of a zero that reads as a broken measurement. */
  raceMode?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const linkableSet = useMemo(
    () => (linkableSlugs ? new Set(linkableSlugs) : null),
    [linkableSlugs],
  );
  const regionCols = useMemo(
    () =>
      regions
        ? regions.map((key) => ({ key, label: RPC_REGION_LABELS[key] }))
        : ALL_REGION_COLS,
    [regions],
  );
  /** A headline p90 is computed over all three regions, so the geo view does
   *  not carry it over: it substitutes the region variant's own tail when
   *  there is one and leaves the column empty when there is not. Same rule as
   *  archive, because an empty column makes a claim of its own. */
  const hasP90 = useMemo(() => rows.some((r) => r.bestP90Ms != null), [rows]);
  /** p95 exists only where a spec asks for it, which today is the keyed
   *  cluster. Gated like every other optional column rather than drawn as a
   *  row of dashes on the benches that do not declare it. */
  const hasP95 = useMemo(() => rows.some((r) => r.bestP95Ms != null), [rows]);
  /** The archive probe only runs on the public cohort: the keyed harness has
   *  no depth probe at all, so on the three API-key cohorts every cell was a
   *  dash and the column read as "no provider serves archive" instead of "not
   *  measured here". Derived from `rows`, not from the search result, so
   *  typing in the box cannot make a column appear and disappear. */
  const hasArchive = useMemo(
    () => rows.some((r) => r.bestArchiveDepthBlocks != null),
    [rows],
  );
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("bestP50");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = needle
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(needle) ||
            r.chain.toLowerCase().includes(needle) ||
            (r.best?.providerName.toLowerCase().includes(needle) ?? false),
        )
      : rows;
    const factor = sortDir === "desc" ? -1 : 1;
    return [...out].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      // Nulls always sink under either sort direction.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string")
        return factor * av.localeCompare(bv);
      return factor * ((av as number) - (bv as number));
    });
  }, [rows, sortKey, sortDir, q]);

  // #, chain, best, providers, trend, plus whatever is drawn.
  const colCount =
    5 +
    regionCols.length +
    (hasP90 ? 1 : 0) +
    (hasP95 ? 1 : 0) +
    (hasArchive ? 1 : 0);

  const setSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      // Latency columns read best ascending; counts descending.
      setSortDir(k === "providerCount" ? "desc" : "asc");
    }
  };

  return (
    <div className="mt-6 card-soft rounded-xl border border-ink/10">
      <div className="p-3 sm:p-4 border-b border-ink/8 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          <p
            className="text-[11px] text-ink-faint"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {filtered.length} of {rows.length} chains measured · 24h p50, {scopeNote}
          </p>
          {geoControl}
        </div>
        <input
          type="search" aria-label="Search chain or provider..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search chain or provider..."
          className="text-[12.5px] px-3 py-1.5 rounded-md border border-ink/15 bg-paper focus:outline-none focus:ring-2 focus:ring-sky-500/30 min-w-[200px]"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <ThSort
                active={sortKey === "name"}
                dir={sortDir}
                onClick={() => setSort("name")}
              >
                Chain
              </ThSort>
              <ThSort
                active={sortKey === "bestP50"}
                dir={sortDir}
                onClick={() => setSort("bestP50")}
              >
                <span title={bestTip}>{bestLabel}</span>
              </ThSort>
              {hasP90 && (
                <ThSort
                  active={sortKey === "bestP90"}
                  dir={sortDir}
                  onClick={() => setSort("bestP90")}
                >
                  <span title="p90 latency of the same overall-best provider, the slow-tail number users actually feel. Empty when the provider's histogram doesn't have enough samples yet.">
                    Best p90
                  </span>
                </ThSort>
              )}
              {hasP95 && (
                <ThSort
                  active={sortKey === "bestP95"}
                  dir={sortDir}
                  onClick={() => setSort("bestP95")}
                >
                  <span title="p95 of the same leading provider: the slow 1 call in 20. Recorded from 2026-10-16; the probe samples every 120 s, so a 24h p95 rests on about the 36th worst of 720 measurements.">
                    Best p95
                  </span>
                </ThSort>
              )}
              {hasArchive && (
                <ThSort
                  active={sortKey === "archive"}
                  dir={sortDir}
                  onClick={() => setSort("archive")}
                >
                  <span title="Max archive block depth supported by the leader (`eth_getBalance` at head-N returns non-pruned). Higher = better for indexers / subgraphs / backfill jobs that need historical state.">
                    Archive
                  </span>
                </ThSort>
              )}
              {regionCols.map((c) => (
                <ThSort
                  key={c.key}
                  active={sortKey === c.key}
                  dir={sortDir}
                  onClick={() => setSort(c.key)}
                >
                  {c.label}
                </ThSort>
              ))}
              <ThSort
                active={sortKey === "providerCount"}
                dir={sortDir}
                onClick={() => setSort("providerCount")}
              >
                Providers
              </ThSort>
              <Th>24h trend</Th>
            </tr>
          </thead>
          <tbody>
            {(showAll || q ? filtered : filtered.slice(0, INITIAL_ROWS)).map((r, i) => {
              // Under the thin gate (< 3 providers) the chain page is noindex:
              // show the row, do not link it (the hub was the main source of
              // noindex crawl on 2026-09-19).
              const linkable = linkableSet
                ? linkableSet.has(r.slug)
                : (r.declaredCount ?? r.providerCount) >= THIN_RPC_MIN_RESULTS;
              return (
              <tr
                key={r.slug}
                onClick={linkable ? () => router.push(`/benchmarks/${r.slug}${benchQuery}`) : undefined}
                className={`border-t border-ink/5 transition-colors ${linkable ? "hover:bg-paper-soft/40 cursor-pointer" : ""}`}
              >
                <Td muted mono>
                  {i + 1}
                </Td>
                <Td>
                  <div className="flex items-center gap-2 min-w-0">
                    {linkable ? (
                    <Link
                      href={`/benchmarks/${r.slug}${benchQuery}`}
                      className="flex items-center gap-2 min-w-0 group"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ProviderLogo slug={r.chain} name={r.name} size={18} />
                      <span className="font-medium text-ink truncate group-hover:underline underline-offset-2">
                        {r.name} <span className="font-normal text-ink-faint">RPC endpoints</span>
                      </span>
                      <ChevronRight
                        size={14}
                        className="text-ink-faint shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </Link>
                    ) : (
                    <span
                      className="flex items-center gap-2 min-w-0"
                      title="Measured, not yet ranked: fewer than 3 no-key providers"
                    >
                      <ProviderLogo slug={r.chain} name={r.name} size={18} />
                      <span className="font-medium text-ink truncate">{r.name}</span>
                      <span className="text-[10px] text-ink-faint shrink-0">not yet ranked</span>
                    </span>
                    )}
                    <Link
                      href={`/chains/${r.chain}`}
                      className="text-[10px] text-ink-faint hover:text-ink underline underline-offset-2 shrink-0"
                      title={`Open the ${r.name} chain hub (KPI cards + full RPC leaderboard)`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      hub
                    </Link>
                  </div>
                </Td>
                <Td>
                  {r.best ? (
                    <span className="inline-flex items-center gap-2 min-w-0">
                      <ProviderLogo
                        slug={r.best.provider}
                        name={r.best.providerName}
                        size={16}
                      />
                      <span className="truncate text-ink">
                        {r.best.providerName}
                      </span>
                      {raceMode ? (
                        <RaceMargin row={r} />
                      ) : (
                        <span
                          className="tabular-nums font-semibold text-sky-600 dark:text-sky-400"
                          style={{ fontFamily: "var(--font-mono, monospace)" }}
                        >
                          {fmtMs(r.best.p50Ms)}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-ink-faint">...</span>
                  )}
                </Td>
                {hasP90 && (
                  <Td mono>
                    {r.bestP90Ms != null ? (
                      <span className="tabular-nums text-ink-soft">
                        {fmtMs(r.bestP90Ms)}
                      </span>
                    ) : (
                      <span className="text-ink-faint">-</span>
                    )}
                  </Td>
                )}
                {hasP95 && (
                  <Td mono>
                    {r.bestP95Ms != null ? (
                      <span className="tabular-nums text-ink-soft">
                        {fmtMs(r.bestP95Ms)}
                      </span>
                    ) : (
                      <span className="text-ink-faint">-</span>
                    )}
                  </Td>
                )}
                {hasArchive && (
                  <Td
                    mono
                    tip={
                      r.bestArchiveDepthBlocks
                        ? `${r.bestArchiveDepthBlocks.toLocaleString()} blocks of historical state, served by: ${
                            r.bestArchiveProviders?.join(", ") || "(none listed)"
                          }. Depth set = {300, 7.2k, 216k, 1.3M, 5M}: 300 is Geth default pruned; 5M is genesis-era full archive. On sub-second-block chains (Arbitrum, Sei) 5M translates to weeks not years, see the per-chain bench page for the exact wall-clock window.`
                        : "No provider on this chain reports archive support (either the archive probe is skipped for the chain family, Solana / Substrate, or every listed provider serves only the default pruned window)."
                    }
                  >
                    {r.bestArchiveDepthBlocks ? (
                      <span className="inline-flex items-baseline gap-1.5">
                        <span className="tabular-nums">
                          {fmtArchive(r.bestArchiveDepthBlocks)}
                        </span>
                        {r.bestArchiveProviders &&
                          r.bestArchiveProviders.length > 0 && (
                            <span className="text-[10.5px] text-ink-faint truncate max-w-[90px]">
                              {r.bestArchiveProviders.length === 1
                                ? r.bestArchiveProviders[0]
                                : `${r.bestArchiveProviders[0]} +${r.bestArchiveProviders.length - 1}`}
                            </span>
                          )}
                      </span>
                    ) : (
                      <span className="text-ink-faint">-</span>
                    )}
                  </Td>
                )}
                {regionCols.map((c) => {
                  const b = r.regions[c.key];
                  return (
                    <Td
                      key={c.key}
                      mono
                      tip={
                        b
                          ? `${b.providerName} leads ${r.name} from ${c.label}`
                          : undefined
                      }
                    >
                      {b ? (
                        <span className="inline-flex items-baseline gap-1.5">
                          <span className="tabular-nums">{fmtMs(b.p50Ms)}</span>
                          <span className="text-[10.5px] text-ink-faint truncate max-w-[72px]">
                            {b.providerName}
                          </span>
                        </span>
                      ) : (
                        "..."
                      )}
                    </Td>
                  );
                })}
                <Td
                  mono
                  tip={
                    r.unresponsiveCount
                      ? `${r.unresponsiveCount} cohort provider${r.unresponsiveCount > 1 ? "s" : ""} currently unresponsive on ${r.name} (probed, all calls failing). Not counted in best/fastest. Providers: ${(r.unresponsive ?? []).map((u) => u.name).join(", ") || "n/a"}`
                      : undefined
                  }
                >
                  {r.providerCount}
                  {r.unresponsiveCount ? (
                    <span className="ml-1.5 text-[10px] text-ink-faint">
                      +{r.unresponsiveCount} down
                    </span>
                  ) : null}
                </Td>
                <Td>
                  {r.series && r.series.length > 1 ? (
                    <Sparkline
                      values={r.series}
                      width={84}
                      height={20}
                      color="var(--color-ink-soft)"
                    />
                  ) : (
                    <span className="text-ink-faint">n/a</span>
                  )}
                </Td>
              </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={colCount}
                  className="px-3 py-8 text-center text-[12px] text-ink-faint"
                >
                  No chain matches &ldquo;{q}&rdquo;.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!showAll && !q && filtered.length > INITIAL_ROWS && (
        <div className="p-3 border-t border-ink/8 text-center">
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-[12px] underline underline-offset-2 text-ink-soft hover:text-ink"
          >
            Show all {filtered.length} chains
          </button>
        </div>
      )}
    </div>
  );
}

/** The margin between the provider that pushes first and the next one.
 *  On a race the leader's own figure is zero by construction, so the gap is
 *  what a reader can act on: it is how much of a head start the winner
 *  gives you over the second-best socket on that chain. */
function RaceMargin({ row }: { row: RpcHubChain }) {
  const field = row.providers ?? [];
  const runnerUp = field[1];
  const margin =
    runnerUp && row.best ? runnerUp.p50Ms - row.best.p50Ms : null;
  if (margin == null || !Number.isFinite(margin) || margin <= 0) {
    return (
      <span
        className="text-[11px] text-ink-faint"
        title="Only one provider has enough blocks on this chain to compare."
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        no runner-up
      </span>
    );
  }
  return (
    <span
      className="tabular-nums font-semibold text-sky-600 dark:text-sky-400"
      style={{ fontFamily: "var(--font-mono, monospace)" }}
      title={`${fmtMs(margin)} ahead of ${runnerUp.name}, comparing each provider's median lag behind whichever one pushed the block first.`}
    >
      {fmtMs(margin)} ahead
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      className="px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide text-ink-faint"
      style={{ fontFamily: "var(--font-mono, monospace)" }}
    >
      {children}
    </th>
  );
}

function ThSort({
  children,
  active,
  dir,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th
      className={`px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide cursor-pointer select-none ${
        active ? "text-ink" : "text-ink-faint hover:text-ink"
      }`}
      style={{ fontFamily: "var(--font-mono, monospace)" }}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <span className="text-[9px]">
          {active ? (dir === "desc" ? "v" : "^") : "::"}
        </span>
      </span>
    </th>
  );
}

function Td({
  children,
  mono,
  muted,
  tip,
}: {
  children: React.ReactNode;
  mono?: boolean;
  muted?: boolean;
  tip?: string;
}) {
  return (
    <td
      className={`px-3 py-2 tabular-nums ${muted ? "text-ink-faint" : ""}`}
      style={mono ? { fontFamily: "var(--font-mono, monospace)" } : undefined}
      title={tip}
    >
      {children}
    </td>
  );
}

function fmtMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "...";
  // One decimal below 10 ms. Rounding to the nearest millisecond printed a
  // 0.3 ms median as "0 ms", which reads as a broken measurement rather than
  // as a provider that is a third of a millisecond behind, and it flattened
  // 2.1 against 5.8 into 2 against 6 on the HTTP cohorts.
  if (v < 10) return `${v.toFixed(1)} ms`;
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

// Compact archive-depth display. Maps the harness's discrete depthBuckets
// to short labels: 300 blocks = "pruned" (Geth default), 7.2k blocks ≈
// 24h on 12s-block chains, 216k ≈ 30d, 1.3M ≈ 6mo, 5M ≈ 2yr. On sub-second
// chains (Arbitrum, Sei) these translate to shorter wall-clock windows;
// the raw block count in the tooltip disambiguates.
function fmtArchive(blocks: number): string {
  if (blocks >= 5_000_000) return "5M+";
  if (blocks >= 1_296_000) return "1.3M";
  if (blocks >= 216_000) return "216k";
  if (blocks >= 7200) return "7.2k";
  if (blocks >= 300) return "300";
  return blocks.toLocaleString();
}
