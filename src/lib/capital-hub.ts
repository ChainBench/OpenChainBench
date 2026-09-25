/**
 * Data for the /capital hub and the live capital report.
 *
 * Everything is read from the materialized benches (the same blobs the
 * bench pages render) plus the two daily history blobs the worker writes
 * (src/lib/capital-history.ts). No Prometheus call at render time.
 *
 * Two cohorts:
 *  - follow the capital: chains, from bench 273 chain-bridged-tvl (L2Beat
 *    value secured), bench 275 chain-stablecoin-flow (DeFiLlama stablecoin
 *    float per chain) and the chains history blob (TVL, native mcap, DEX
 *    volume, chain fees and revenue when the chain-kpis harness publishes
 *    them); open interest from bench 265 (perp DEX OI) and bench 277
 *    (prediction markets).
 *  - valuation: bench 274 protocol-pf-ratio (cross-DeFi P/F, fees MoM,
 *    token 30d, category median) and bench 265 perp-pf-ratio (P/F, P/S,
 *    FDV, float, OI, fees and revenue).
 *
 * Every field is independently nullable and rendered as a dash when
 * missing. A bench that is not live on this deployment (dev-only gating)
 * or that fails to load contributes nothing and its section is skipped.
 * Sentences describe the numbers and what they are compared against; they
 * never issue a verdict.
 */

import { cache } from "react";
import { unstable_cache } from "next/cache";
import { getBenchmark } from "@/data/benchmarks";
import { loadSnapshotFromBlob } from "@/lib/bench-blob";
import { CHAINS } from "@/lib/chains";
import { isDevOnlyBench } from "@/lib/removed-benches";
import { getProviderRegistry } from "@/data/provider-registry";
import { getChainsHistory, getValuationHistory, type CapitalEntity } from "@/lib/capital-history";
import type { Benchmark, ProviderResult } from "@/types/benchmark";
import {
  CAPITAL_BENCHES,
  fmtUsdShort,
  type CapitalHub,
  type ChainRow,
  type FlowShare,
  type OiRow,
  type PerpRow,
  type ProtocolRow,
} from "@/lib/capital-hub-types";
import { cctpScope, change7dFromDays, change7dFromSeries, median7dPct, selectDivergences } from "@/lib/capital-hub-rules";

export * from "@/lib/capital-hub-types";

const CHAIN_NAME = new Map(CHAINS.map((c) => [c.slug, c.label]));
const CHAIN_SLUGS = new Set(CHAINS.map((c) => c.slug));

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function panel(b: Benchmark | undefined, id: string, slug: string): number | null {
  return num(b?.metricPanels?.find((p) => p.id === id)?.values[slug]);
}

/**
 * True when a panel reads one plain gauge: `protocol_tvl_usd{}` and
 * `protocol_tvl_usd`, not a label-filtered or composed expression, so a
 * `protocol_tvl_usd{scope="perps"}` panel listed first never feeds the
 * TVL column.
 */
function readsPlainGauge(metric: string, gauge: string): boolean {
  const m = metric.trim();
  return m === gauge || m === `${gauge}{}`;
}

/**
 * A panel found by the gauge it reads rather than by id, for the columns
 * whose spec entry another harness round adds (bench 274's TVL, revenue,
 * P/S and supply change): whichever id the spec chooses, the hub reads
 * the value once the panel exists, and null before.
 */
function panelByGauge(b: Benchmark | undefined, gauge: string, slug: string): number | null {
  return num(b?.metricPanels?.find((p) => readsPlainGauge(p.metric, gauge))?.values[slug]);
}

type Series7d = { headline: Record<string, (number | null)[]>; panels: Record<string, Record<string, (number | null)[]>> };

/**
 * The 7d series of a bench, from the worker-published blob: the bench the
 * page renders comes through slimBenchmarkForCache, which strips
 * extras.series7d and every panel's seriesByProvider7d (src/lib/spec.ts),
 * so the open interest 7d change reads the full snapshot the way
 * /api/series does. Only the series maps are kept in the cache entry.
 */
const series7dOf = unstable_cache(
  async (slug: string): Promise<Series7d | null> => {
    try {
      const snap = await loadSnapshotFromBlob(slug, "");
      if (!snap) return null;
      const panels: Series7d["panels"] = {};
      for (const p of snap.bench.metricPanels ?? []) if (p.seriesByProvider7d) panels[p.id] = p.seriesByProvider7d;
      return { headline: snap.bench.extras?.series7d ?? {}, panels };
    } catch {
      return null;
    }
  },
  ["capital-series7d-v1"],
  { revalidate: 300, tags: ["capital-history"] },
);

/** Ranked, live rows with a finite headline value. */
function liveRows(b: Benchmark | undefined): ProviderResult[] {
  if (!b || b.status !== "live") return [];
  return b.results.filter(
    (r) => r.availability !== "unavailable" && !r.unrankedLabel && Number.isFinite(r.ms.p50),
  );
}

type Loaded = { bench: Benchmark | undefined; failed: boolean };
const NOT_SERVED: Loaded = { bench: undefined, failed: false };

/** A live bench, or why there is none: `failed` (the load threw, a
 *  transient state under a one hour ISR window) is not the same as
 *  "not served or not live", and the page words the two differently. */
async function loadLive(slug: string): Promise<Loaded> {
  try {
    const b = await getBenchmark(slug);
    return { bench: b && b.status === "live" ? b : undefined, failed: false };
  } catch {
    return { bench: undefined, failed: true };
  }
}

/** Every provider the spec lists, unavailable and unranked rows included: cohort membership, as opposed to `liveRows`. */
function members(b: Benchmark | undefined): Set<string> {
  return new Set((b?.results ?? []).map((r) => r.slug));
}

/** The bench tag reads "Lending, lending P/F median 3.2": keep the
 *  category and spell the acronyms the way DeFiLlama's pages do. */
function categoryLabel(raw: string): string {
  const head = raw.split(",")[0].trim();
  const fixes: Record<string, string> = { Dexs: "DEXs", Rwa: "RWA", "Dex Aggregator": "DEX Aggregator", Cdp: "CDP" };
  return fixes[head] ?? head;
}

/**
 * The entity's newest daily point, and only when it is today's or
 * yesterday's relative to the blob's own generated_at. The worker keeps
 * 400 days and leaves a field out of a day when the harness deleted the
 * gauge on purpose (DeFiLlama not tracking it, a month with no fees), so
 * walking back to "the last day that had the field" would show deleted
 * values forever and could pair today's fees with weeks-old revenue.
 * Every field of a row is read from this one point.
 */
function freshPoint(entity: CapitalEntity | undefined, generatedAt: string | undefined): Record<string, unknown> | null {
  if (!entity || entity.days.length === 0 || !generatedAt) return null;
  const t = Date.parse(generatedAt);
  if (!Number.isFinite(t)) return null;
  const today = new Date(t).toISOString().slice(0, 10);
  const yesterday = new Date(t - 86_400_000).toISOString().slice(0, 10);
  const last = entity.days[entity.days.length - 1];
  return last.day === today || last.day === yesterday ? last : null;
}

function field(pt: Record<string, unknown> | null, name: string): number | null {
  return pt ? num(pt[name]) : null;
}

async function buildHub(): Promise<CapitalHub> {
  // A dev-only bench stays off the production hub entirely (no column, no chip to a 404).
  const cctpServed = !isDevOnlyBench(CAPITAL_BENCHES.usdcCorridor);
  // Bench 280 (chain fees and revenue) is dev-only until its audit round:
  // its series stay off the hub on deployments that do not serve the bench.
  const feesServed = !isDevOnlyBench(CAPITAL_BENCHES.chainFees);
  const [bridgedL, stablesL, protocolsL, perpsL, pmL, cctpL, feesL, chainsHist, valHist, pmSeries, perpSeries] = await Promise.all([
    loadLive(CAPITAL_BENCHES.bridgedTvl),
    loadLive(CAPITAL_BENCHES.stableFlow),
    loadLive(CAPITAL_BENCHES.protocolPf),
    loadLive(CAPITAL_BENCHES.perpPf),
    loadLive(CAPITAL_BENCHES.pmOi),
    cctpServed ? loadLive(CAPITAL_BENCHES.usdcCorridor) : Promise.resolve(NOT_SERVED),
    feesServed ? loadLive(CAPITAL_BENCHES.chainFees) : Promise.resolve(NOT_SERVED),
    getChainsHistory().catch(() => null),
    getValuationHistory().catch(() => null),
    series7dOf(CAPITAL_BENCHES.pmOi).catch(() => null),
    series7dOf(CAPITAL_BENCHES.perpPf).catch(() => null),
  ]);

  const bridged = bridgedL.bench;
  const stables = stablesL.bench;
  const protocolsB = protocolsL.bench;
  const perpsB = perpsL.bench;
  const pmB = pmL.bench;
  const cctp = cctpL.bench;
  const feesB = feesL.bench;
  const entry = (slug: string, l: Loaded, fallbackTitle: string) => ({
    slug,
    title: l.bench?.title ?? fallbackTitle,
    live: !!l.bench,
    failed: l.failed,
  });
  const benches = [
    entry(CAPITAL_BENCHES.bridgedTvl, bridgedL, "Bridged TVL per chain"),
    entry(CAPITAL_BENCHES.stableFlow, stablesL, "Stablecoin flows per chain"),
    entry(CAPITAL_BENCHES.protocolPf, protocolsL, "Protocol price to fees"),
    entry(CAPITAL_BENCHES.perpPf, perpsL, "Perp DEX price to fees"),
    entry(CAPITAL_BENCHES.pmOi, pmL, "Prediction market open interest"),
    ...(cctpServed ? [entry(CAPITAL_BENCHES.usdcCorridor, cctpL, "USDC corridor flows over CCTP")] : []),
    ...(feesServed ? [entry(CAPITAL_BENCHES.chainFees, feesL, "Chain fees and revenue")] : []),
  ];

  const asOfMs = [bridged, stables, protocolsB, perpsB, pmB, cctp, feesB]
    .map((b) => (b?.lastRunAt ? Date.parse(b.lastRunAt) : NaN))
    .filter((t) => Number.isFinite(t));
  const asOf = asOfMs.length > 0 ? new Date(Math.max(...asOfMs)).toISOString() : null;

  // ---- chains -----------------------------------------------------------
  const chainEntities = new Map((chainsHist?.chains ?? []).map((c) => [c.slug, c]));
  const chainSlugs = new Set<string>();
  // Every cohort member gets a row (rows with no value anywhere are dropped below).
  for (const r of bridged?.results ?? []) chainSlugs.add(r.slug);
  for (const r of stables?.results ?? []) chainSlugs.add(r.slug);
  const bridgedMembers = members(bridged);
  const stablesMembers = members(stables);
  const feesMembers = members(feesB);
  // Bench 281's provider list is the set of chains scanned as CCTP sources.
  const cctpScanned = members(cctp);
  for (const c of chainEntities.keys()) chainSlugs.add(c);
  const bridgedBy = new Map(liveRows(bridged).map((r) => [r.slug, r]));
  const stablesBy = new Map(liveRows(stables).map((r) => [r.slug, r]));
  const cctpBy = new Map(liveRows(cctp).map((r) => [r.slug, r]));
  const feesBy = new Map(liveRows(feesB).map((r) => [r.slug, r]));

  const rawChains = [...chainSlugs].map((slug) => {
    const pt = freshPoint(chainEntities.get(slug), chainsHist?.generatedAt);
    const br = bridgedBy.get(slug);
    const st = stablesBy.get(slug);
    // Membership is known only when the bench loaded; otherwise n/a, never a dash.
    const inStablesCohort = stables ? stablesMembers.has(slug) : true;
    const inFeesCohort = feesB ? feesMembers.has(slug) : true;
    const change7dPct = panel(bridged, "change_7d", slug);
    const excess7dPct = panel(bridged, "excess_7d", slug);
    // The blob's series for the two bench-ranked columns, kept apart from
    // the ranked value: shown muted for a chain outside the cohort, never
    // ranked, counted or crowned (leaders, FAQ, inflow bar and badge read
    // the ranked field only).
    const blobNet30d = field(pt, "stables_net_30d");
    const blobFees30d = feesServed ? field(pt, "fees_30d") : null;
    const blobRevenue30d = feesServed ? field(pt, "revenue_30d") : null;
    // Ranked fees only from bench 280's ranked rows, as net flow from bench
    // 275's: a listed but unranked chain reads n/a, and a bench that did
    // not load leaves every cell n/a instead of passing the blob off as ranked.
    const fe = feesBy.get(slug);
    const row: Omit<ChainRow, "hasChainPage"> = {
      slug,
      name: CHAIN_NAME.get(slug) ?? br?.name ?? st?.name ?? slug,
      tvl: field(pt, "tvl"),
      inBridgedCohort: bridged ? bridgedMembers.has(slug) : true,
      inStablesCohort,
      inFeesCohort,
      bridgedTvl: br ? num(br.ms.p50) : null,
      bridgedSharePct: panel(bridged, "bridged_share", slug),
      change7dPct,
      excess7dPct,
      median7dPct: median7dPct(change7dPct, excess7dPct),
      stablesFloat: panel(stables, "float_usd", slug) ?? field(pt, "stables_mcap"),
      // Net flow only from bench 275's ranked rows: the blob carries every
      // registry chain, and a chain outside the $100M cohort (or a cohort
      // row the bench withholds) must not be ranked, counted or crowned.
      stablesNet30d: st ? num(st.ms.p50) : null,
      stablesNet30dOutside: inStablesCohort ? null : blobNet30d,
      stablesChange30dPct: panel(stables, "change_30d", slug),
      stablesNet7d: panel(stables, "net_7d", slug),
      // Scope is meaningful only where the bench is served; off it the
      // column is absent and the field is stripped from the JSON.
      cctpScope: cctpScope(slug, cctpScanned),
      cctpNet7d: cctpBy.has(slug) ? num(cctpBy.get(slug)!.ms.p50) : null,
      cctpIn7d: panel(cctp, "inflow_7d", slug),
      cctpOut7d: panel(cctp, "outflow_7d", slug),
      dexVolume24h: field(pt, "dex_volume_24h"),
      nativeMcap: field(pt, "native_mcap"),
      fees30d: fe ? num(fe.ms.p50) : null,
      revenue30d: fe ? panel(feesB, "revenue_30d", slug) : null,
      fees30dOutside: inFeesCohort ? null : blobFees30d,
      revenue30dOutside: inFeesCohort ? null : blobRevenue30d,
    };
    return row;
  });
  // The inflow leader must have an inflow: a month where every cohort
  // chain lost float has no leader rather than the smallest outflow.
  const stableLeaderSlug = [...rawChains]
    .filter((c) => c.stablesNet30d != null && c.stablesNet30d > 0)
    .sort((a, b) => (b.stablesNet30d ?? 0) - (a.stablesNet30d ?? 0))[0]?.slug;
  const chains: ChainRow[] = rawChains
    .filter((c) => c.tvl != null || c.bridgedTvl != null || c.stablesNet30d != null || c.stablesFloat != null)
    .map((c) => ({
      ...c,
      hasChainPage: CHAIN_SLUGS.has(c.slug),
    }))
    // Largest capital base first: TVL, else stablecoin float, else bridged.
    // One declared measure, DeFi TVL, nulls last; ties and the few rows
    // without a TVL fall back to bridged value so an L2Beat-only row still
    // sits above dust rather than at a random place (audit 2026-09-25).
    .sort((a, b) => {
      if (a.tvl != null && b.tvl != null && a.tvl !== b.tvl) return b.tvl - a.tvl;
      if (a.tvl != null && b.tvl == null) return -1;
      if (a.tvl == null && b.tvl != null) return 1;
      return (b.bridgedTvl ?? b.stablesFloat ?? 0) - (a.bridgedTvl ?? a.stablesFloat ?? 0);
    });

  const inflows = chains.filter((c) => (c.stablesNet30d ?? 0) > 0);
  const inflowTotal = inflows.reduce((s, c) => s + (c.stablesNet30d ?? 0), 0);
  const stableFlowShares: FlowShare[] = inflows
    .map((c) => ({ slug: c.slug, name: c.name, usd: c.stablesNet30d ?? 0, pct: inflowTotal > 0 ? ((c.stablesNet30d ?? 0) / inflowTotal) * 100 : 0 }))
    .sort((a, b) => b.usd - a.usd);

  // ---- open interest ----------------------------------------------------
  // Prediction markets carry no daily history blob: the 7d change reads the
  // bench's own 7d series of the headline (full snapshot) when it covers the window.
  const pmOi: OiRow[] = liveRows(pmB)
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      oi: r.ms.p50,
      volume24h: panel(pmB, "volume_24h", r.slug),
      turnover: panel(pmB, "turnover", r.slug),
      change7dPct: change7dFromSeries(pmSeries?.headline[r.slug]),
    }))
    .filter((r) => r.oi > 0)
    .sort((a, b) => b.oi - a.oi);

  // Perp DEX open interest: the valuation blob's daily `oi` gives the 7d
  // change once it holds the older day (and its newest day is recent by
  // the clock, so a stalled worker publishes nothing); the oi panel's 7d
  // series from the full snapshot before that.
  const valPerps = new Map((valHist?.perps ?? []).map((p) => [p.slug, p]));
  const now = Date.now();
  const perpOi: OiRow[] = (perpsB?.results ?? [])
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      oi: panel(perpsB, "oi", r.slug) ?? 0,
      volume24h: null,
      turnover: null,
      change7dPct: change7dFromDays(valPerps.get(r.slug)?.days ?? [], "oi", now) ?? change7dFromSeries(perpSeries?.panels.oi?.[r.slug]),
    }))
    .filter((r) => r.oi > 0)
    .sort((a, b) => b.oi - a.oi);

  // ---- valuation: protocols ---------------------------------------------
  const valProtocols = new Map((valHist?.protocols ?? []).map((p) => [p.slug, p]));
  const protocols: ProtocolRow[] = liveRows(protocolsB)
    .map((r) => {
      const pf = num(r.ms.p50);
      const pfVsCategory = panel(protocolsB, "pf_vs_category", r.slug);
      // The four columns the protocol-valuation harness adds next: the
      // bench panel when the spec carries it, the blob field otherwise,
      // null (and a hidden column) before either exists.
      const vpt = freshPoint(valProtocols.get(r.slug), valHist?.generatedAt);
      const base: Omit<ProtocolRow, "hasProductPage" | "signal"> = {
        slug: r.slug,
        name: r.name,
        category: categoryLabel(valProtocols.get(r.slug)?.category || r.tag || ""),
        pf,
        pfFdv: panel(protocolsB, "pf_fdv", r.slug),
        floatPct: panel(protocolsB, "float_pct", r.slug),
        feeGrowth30dPct: panel(protocolsB, "fee_growth", r.slug),
        priceChange30dPct: panel(protocolsB, "price_change", r.slug),
        pfVsCategory,
        categoryMedianPf: pf != null && pfVsCategory != null && pfVsCategory > 0 ? pf / pfVsCategory : null,
        fees30d: panel(protocolsB, "fees_30d", r.slug),
        tvl: panelByGauge(protocolsB, "protocol_tvl_usd", r.slug) ?? field(vpt, "tvl"),
        revenue30d: panelByGauge(protocolsB, "protocol_revenue_30d_usd", r.slug) ?? field(vpt, "rev_30d"),
        revenueIncomplete: (panelByGauge(protocolsB, "protocol_revenue_incomplete", r.slug) ?? field(vpt, "revenue_incomplete") ?? 0) >= 1,
        ps: panelByGauge(protocolsB, "protocol_ps_ratio", r.slug) ?? field(vpt, "ps"),
        supplyChange30dPct: panelByGauge(protocolsB, "protocol_supply_change_30d_pct", r.slug) ?? field(vpt, "supply_change_30d_pct"),
      };
      // Same three clauses as the harness's protocol_diverging, plus the
      // mirror image, so the screen is symmetric and never a one-way tip.
      let signal: ProtocolRow["signal"] = null;
      if (base.feeGrowth30dPct != null && base.priceChange30dPct != null && pfVsCategory != null) {
        if (base.feeGrowth30dPct > 0 && base.priceChange30dPct < 0 && pfVsCategory < 1) signal = "fees-up-token-down";
        else if (base.feeGrowth30dPct < 0 && base.priceChange30dPct > 0 && pfVsCategory > 1) signal = "fees-down-token-up";
      }
      return { ...base, signal, hasProductPage: getProviderRegistry(r.slug) !== undefined };
    })
    .filter((r) => r.pf != null && r.pf > 0)
    .sort((a, b) => (a.pf ?? 0) - (b.pf ?? 0));

  // ---- valuation: perps -------------------------------------------------
  const perps: PerpRow[] = liveRows(perpsB)
    .map((r) => {
      const base: Omit<PerpRow, "hasProductPage"> = {
        slug: r.slug,
        name: r.name,
        pf: num(r.ms.p50),
        ps: panel(perpsB, "ps", r.slug),
        pfFdv: panel(perpsB, "pf_fdv", r.slug),
        mcap: panel(perpsB, "mcap", r.slug),
        fdv: panel(perpsB, "fdv", r.slug),
        floatPct: panel(perpsB, "float_pct", r.slug),
        oi: panel(perpsB, "oi", r.slug),
        fees30d: panel(perpsB, "fees_30d", r.slug),
        rev30d: panel(perpsB, "rev_30d", r.slug),
      };
      return { ...base, hasProductPage: getProviderRegistry(r.slug) !== undefined };
    })
    .filter((r) => r.pf != null && r.pf > 0)
    .sort((a, b) => (a.pf ?? 0) - (b.pf ?? 0));

  const historyDays = Math.max(
    0,
    ...(chainsHist?.chains ?? []).map((c) => c.days.length),
    ...(valHist?.protocols ?? []).map((p) => p.days.length),
  );

  // The bench calls two rows tied when they print the same value (citation.ts);
  // the hub must not name one of them alone on a $6M gap (SEO audit 2026-09-25).
  const bridgedRanked = [...chains].filter((c) => c.bridgedTvl != null).sort((a, b) => (b.bridgedTvl ?? 0) - (a.bridgedTvl ?? 0));
  return {
    asOf,
    benches,
    chains,
    stableFlowShares,
    perpOi,
    pmOi,
    protocols,
    divergences: selectDivergences(protocols),
    perps,
    leaders: {
      bridgedTvl: bridgedRanked[0] ?? null,
      bridgedTvlTied: bridgedRanked.filter((c) => bridgedRanked[0] && fmtUsdShort(c.bridgedTvl) === fmtUsdShort(bridgedRanked[0].bridgedTvl)),
      stableInflow: chains.find((c) => c.slug === stableLeaderSlug) ?? null,
      lowestPfProtocol: protocols[0] ?? null,
      lowestPfPerp: perps[0] ?? null,
      pmOi: pmOi[0] ?? null,
    },
    historyDays,
  };
}

export const getCapitalHub = cache(buildHub);
