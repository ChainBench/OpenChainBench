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
import { getBenchmark } from "@/data/benchmarks";
import { CHAINS } from "@/lib/chains";
import { isDevOnlyBench } from "@/lib/removed-benches";
import { getProviderRegistry } from "@/data/provider-registry";
import { getChainsHistory, getValuationHistory, type CapitalEntity } from "@/lib/capital-history";
import type { Benchmark, ProviderResult } from "@/types/benchmark";
import {
  CAPITAL_BENCHES,
  type CapitalHub,
  type ChainRow,
  type FlowShare,
  type OiRow,
  type PerpRow,
  type ProtocolRow,
} from "@/lib/capital-hub-types";

export * from "@/lib/capital-hub-types";

const CHAIN_NAME = new Map(CHAINS.map((c) => [c.slug, c.label]));
const CHAIN_SLUGS = new Set(CHAINS.map((c) => c.slug));

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function panel(b: Benchmark | undefined, id: string, slug: string): number | null {
  return num(b?.metricPanels?.find((p) => p.id === id)?.values[slug]);
}

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
  const [bridgedL, stablesL, protocolsL, perpsL, pmL, cctpL, chainsHist, valHist] = await Promise.all([
    loadLive(CAPITAL_BENCHES.bridgedTvl),
    loadLive(CAPITAL_BENCHES.stableFlow),
    loadLive(CAPITAL_BENCHES.protocolPf),
    loadLive(CAPITAL_BENCHES.perpPf),
    loadLive(CAPITAL_BENCHES.pmOi),
    // A dev-only bench stays off the production hub entirely (no column, no chip to a 404).
    isDevOnlyBench(CAPITAL_BENCHES.usdcCorridor) ? Promise.resolve(NOT_SERVED) : loadLive(CAPITAL_BENCHES.usdcCorridor),
    getChainsHistory().catch(() => null),
    getValuationHistory().catch(() => null),
  ]);

  const bridged = bridgedL.bench;
  const stables = stablesL.bench;
  const protocolsB = protocolsL.bench;
  const perpsB = perpsL.bench;
  const pmB = pmL.bench;
  const cctp = cctpL.bench;
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
    ...(isDevOnlyBench(CAPITAL_BENCHES.usdcCorridor) ? [] : [entry(CAPITAL_BENCHES.usdcCorridor, cctpL, "USDC corridor flows over CCTP")]),
  ];

  const asOfMs = [bridged, stables, protocolsB, perpsB, pmB, cctp]
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
  for (const c of chainEntities.keys()) chainSlugs.add(c);
  const bridgedBy = new Map(liveRows(bridged).map((r) => [r.slug, r]));
  const stablesBy = new Map(liveRows(stables).map((r) => [r.slug, r]));
  const cctpBy = new Map(liveRows(cctp).map((r) => [r.slug, r]));

  // Bench 280 (chain fees and revenue) is dev-only until its audit round:
  // its series stay off the hub on deployments that do not serve the bench.
  const feesServed = !isDevOnlyBench("chain-fees-revenue");
  const rawChains = [...chainSlugs].map((slug) => {
    const pt = freshPoint(chainEntities.get(slug), chainsHist?.generatedAt);
    const br = bridgedBy.get(slug);
    const st = stablesBy.get(slug);
    const row: Omit<ChainRow, "hasChainPage"> = {
      slug,
      name: CHAIN_NAME.get(slug) ?? br?.name ?? st?.name ?? slug,
      tvl: field(pt, "tvl"),
      // Membership is known only when the bench loaded; otherwise n/a, never a dash.
      inBridgedCohort: bridged ? bridgedMembers.has(slug) : true,
      inStablesCohort: stables ? stablesMembers.has(slug) : true,
      bridgedTvl: br ? num(br.ms.p50) : null,
      bridgedSharePct: panel(bridged, "bridged_share", slug),
      change7dPct: panel(bridged, "change_7d", slug),
      excess7dPct: panel(bridged, "excess_7d", slug),
      stablesFloat: panel(stables, "float_usd", slug) ?? field(pt, "stables_mcap"),
      // Net flow only from bench 275's ranked rows: the blob carries every
      // registry chain, and a chain outside the $100M cohort (or a cohort
      // row the bench withholds) must not be ranked, counted or crowned.
      stablesNet30d: st ? num(st.ms.p50) : null,
      stablesChange30dPct: panel(stables, "change_30d", slug),
      stablesNet7d: panel(stables, "net_7d", slug),
      cctpNet7d: cctpBy.has(slug) ? num(cctpBy.get(slug)!.ms.p50) : null,
      cctpIn7d: panel(cctp, "inflow_7d", slug),
      cctpOut7d: panel(cctp, "outflow_7d", slug),
      dexVolume24h: field(pt, "dex_volume_24h"),
      nativeMcap: field(pt, "native_mcap"),
      fees30d: feesServed ? field(pt, "fees_30d") : null,
      revenue30d: feesServed ? field(pt, "revenue_30d") : null,
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
    .sort((a, b) => (b.tvl ?? b.stablesFloat ?? b.bridgedTvl ?? 0) - (a.tvl ?? a.stablesFloat ?? a.bridgedTvl ?? 0));

  const inflows = chains.filter((c) => (c.stablesNet30d ?? 0) > 0);
  const inflowTotal = inflows.reduce((s, c) => s + (c.stablesNet30d ?? 0), 0);
  const stableFlowShares: FlowShare[] = inflows
    .map((c) => ({ slug: c.slug, name: c.name, usd: c.stablesNet30d ?? 0, pct: inflowTotal > 0 ? ((c.stablesNet30d ?? 0) / inflowTotal) * 100 : 0 }))
    .sort((a, b) => b.usd - a.usd);

  // ---- open interest ----------------------------------------------------
  const pmOi: OiRow[] = liveRows(pmB)
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      oi: r.ms.p50,
      volume24h: panel(pmB, "volume_24h", r.slug),
      turnover: panel(pmB, "turnover", r.slug),
    }))
    .filter((r) => r.oi > 0)
    .sort((a, b) => b.oi - a.oi);

  const perpOi: OiRow[] = (perpsB?.results ?? [])
    .map((r) => ({ slug: r.slug, name: r.name, oi: panel(perpsB, "oi", r.slug) ?? 0, volume24h: null, turnover: null }))
    .filter((r) => r.oi > 0)
    .sort((a, b) => b.oi - a.oi);

  // ---- valuation: protocols ---------------------------------------------
  const valProtocols = new Map((valHist?.protocols ?? []).map((p) => [p.slug, p]));
  const protocols: ProtocolRow[] = liveRows(protocolsB)
    .map((r) => {
      const pf = num(r.ms.p50);
      const pfVsCategory = panel(protocolsB, "pf_vs_category", r.slug);
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

  return {
    asOf,
    benches,
    chains,
    stableFlowShares,
    perpOi,
    pmOi,
    protocols,
    perps,
    leaders: {
      bridgedTvl: [...chains].filter((c) => c.bridgedTvl != null).sort((a, b) => (b.bridgedTvl ?? 0) - (a.bridgedTvl ?? 0))[0] ?? null,
      stableInflow: chains.find((c) => c.slug === stableLeaderSlug) ?? null,
      lowestPfProtocol: protocols[0] ?? null,
      lowestPfPerp: perps[0] ?? null,
      pmOi: pmOi[0] ?? null,
    },
    historyDays,
  };
}

export const getCapitalHub = cache(buildHub);
