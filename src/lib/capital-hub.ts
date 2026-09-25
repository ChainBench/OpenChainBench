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
  fmtPct,
  fmtUsdShort,
  fmtX,
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

async function loadLive(slug: string): Promise<Benchmark | undefined> {
  try {
    const b = await getBenchmark(slug);
    return b && b.status === "live" ? b : undefined;
  } catch {
    return undefined;
  }
}

/** The bench tag reads "Lending, lending P/F median 3.2": keep the
 *  category and spell the acronyms the way DeFiLlama's pages do. */
function categoryLabel(raw: string): string {
  const head = raw.split(",")[0].trim();
  const fixes: Record<string, string> = { Dexs: "DEXs", Rwa: "RWA", "Dex Aggregator": "DEX Aggregator", Cdp: "CDP" };
  return fixes[head] ?? head;
}

function latest(entity: CapitalEntity | undefined, field: string): number | null {
  if (!entity) return null;
  for (let i = entity.days.length - 1; i >= 0; i--) {
    const v = entity.days[i][field];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function chainNote(r: Omit<ChainRow, "note" | "hasChainPage">, stableLeader: boolean, excessLeader: boolean): string {
  const parts: string[] = [];
  if (r.stablesNet30d != null) {
    const dir = r.stablesNet30d >= 0 ? "grew" : "shrank";
    const pct = r.stablesChange30dPct != null ? ` (${fmtPct(r.stablesChange30dPct)})` : "";
    parts.push(
      `Stablecoin float ${dir} ${fmtUsdShort(Math.abs(r.stablesNet30d))}${pct} over 30 days${stableLeader ? ", the largest inflow in the cohort" : ""}`,
    );
  }
  if (r.excess7dPct != null) {
    const rel = r.excess7dPct >= 0 ? "ahead of" : "behind";
    parts.push(
      `value secured moved ${fmtPct(r.change7dPct)} this week, ${fmtPct(Math.abs(r.excess7dPct))} ${rel} the L2 median${excessLeader ? ", the widest lead" : ""}`,
    );
  } else if (r.bridgedTvl != null && r.bridgedSharePct != null) {
    parts.push(`${r.bridgedSharePct.toFixed(0)}% of its value secured arrived from another chain`);
  }
  if (r.cctpNet7d != null) {
    parts.push(`${fmtUsdShort(Math.abs(r.cctpNet7d))} of USDC ${r.cctpNet7d >= 0 ? "arrived over" : "left over"} Circle CCTP in 7 days`);
  }
  if (r.fees30d != null && r.revenue30d != null && r.fees30d > 0) {
    parts.push(`the chain kept ${((r.revenue30d / r.fees30d) * 100).toFixed(0)}% of ${fmtUsdShort(r.fees30d)} in 30-day fees`);
  }
  if (parts.length === 0) return r.tvl != null ? `TVL ${fmtUsdShort(r.tvl)}, no flow reading yet.` : "No reading yet.";
  const s = parts.join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function protocolNote(r: Omit<ProtocolRow, "note" | "hasProductPage" | "signal">): string {
  const parts: string[] = [];
  if (r.feeGrowth30dPct != null && r.priceChange30dPct != null) {
    const fees = `fees ${r.feeGrowth30dPct >= 0 ? "up" : "down"} ${Math.abs(r.feeGrowth30dPct).toFixed(0)}% month over month`;
    const px = `the token ${r.priceChange30dPct >= 0 ? "rose" : "fell"} ${Math.abs(r.priceChange30dPct).toFixed(0)}% over 30 days`;
    parts.push(`${fees} while ${px}`);
  } else if (r.feeGrowth30dPct != null) {
    parts.push(`fees ${r.feeGrowth30dPct >= 0 ? "up" : "down"} ${Math.abs(r.feeGrowth30dPct).toFixed(0)}% month over month`);
  }
  if (r.pf != null && r.categoryMedianPf != null) {
    parts.push(`P/F ${fmtX(r.pf)} against a ${r.category || "peer"} median of ${fmtX(r.categoryMedianPf)}`);
  } else if (r.pf != null) {
    parts.push(`P/F ${fmtX(r.pf)}`);
  }
  if (r.floatPct != null && r.floatPct < 50) {
    parts.push(`${r.floatPct.toFixed(0)}% of the supply circulates`);
  }
  if (parts.length === 0) return "No reading yet.";
  const s = parts.join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function perpNote(r: Omit<PerpRow, "note" | "hasProductPage">): string {
  const parts: string[] = [];
  if (r.pf != null) parts.push(`P/F ${fmtX(r.pf)}`);
  if (r.ps != null) parts.push(`P/S ${fmtX(r.ps)}`);
  if (r.mcap != null && r.fdv != null && r.fdv > 0 && r.floatPct != null) {
    parts.push(`${r.floatPct.toFixed(0)}% of the supply circulates (FDV ${fmtUsdShort(r.fdv)})`);
  }
  if (r.fees30d != null && r.rev30d != null && r.fees30d > 0) {
    parts.push(`${((r.rev30d / r.fees30d) * 100).toFixed(0)}% of ${fmtUsdShort(r.fees30d)} in 30-day fees reached the protocol`);
  }
  if (r.oi != null) parts.push(`open interest ${fmtUsdShort(r.oi)}`);
  if (parts.length === 0) return "No token, or no fee reading yet.";
  const s = parts.join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

async function buildHub(): Promise<CapitalHub> {
  const [bridged, stables, protocolsB, perpsB, pmB, cctp, chainsHist, valHist] = await Promise.all([
    loadLive(CAPITAL_BENCHES.bridgedTvl),
    loadLive(CAPITAL_BENCHES.stableFlow),
    loadLive(CAPITAL_BENCHES.protocolPf),
    loadLive(CAPITAL_BENCHES.perpPf),
    loadLive(CAPITAL_BENCHES.pmOi),
    // A dev-only bench stays off the production hub entirely (no column, no chip to a 404).
    isDevOnlyBench(CAPITAL_BENCHES.usdcCorridor) ? Promise.resolve(undefined) : loadLive(CAPITAL_BENCHES.usdcCorridor),
    getChainsHistory().catch(() => null),
    getValuationHistory().catch(() => null),
  ]);

  const benches = [
    { slug: CAPITAL_BENCHES.bridgedTvl, title: bridged?.title ?? "Bridged TVL per chain", live: !!bridged },
    { slug: CAPITAL_BENCHES.stableFlow, title: stables?.title ?? "Stablecoin flows per chain", live: !!stables },
    { slug: CAPITAL_BENCHES.protocolPf, title: protocolsB?.title ?? "Protocol price to fees", live: !!protocolsB },
    { slug: CAPITAL_BENCHES.perpPf, title: perpsB?.title ?? "Perp DEX price to fees", live: !!perpsB },
    { slug: CAPITAL_BENCHES.pmOi, title: pmB?.title ?? "Prediction market open interest", live: !!pmB },
    ...(isDevOnlyBench(CAPITAL_BENCHES.usdcCorridor)
      ? []
      : [{ slug: CAPITAL_BENCHES.usdcCorridor, title: cctp?.title ?? "USDC corridor flows over CCTP", live: !!cctp }]),
  ];

  const asOfMs = [bridged, stables, protocolsB, perpsB, pmB, cctp]
    .map((b) => (b?.lastRunAt ? Date.parse(b.lastRunAt) : NaN))
    .filter((t) => Number.isFinite(t));
  const asOf = asOfMs.length > 0 ? new Date(Math.max(...asOfMs)).toISOString() : null;

  // ---- chains -----------------------------------------------------------
  const chainEntities = new Map((chainsHist?.chains ?? []).map((c) => [c.slug, c]));
  const chainSlugs = new Set<string>();
  for (const r of liveRows(bridged)) chainSlugs.add(r.slug);
  for (const r of liveRows(stables)) chainSlugs.add(r.slug);
  for (const c of chainEntities.keys()) chainSlugs.add(c);
  const bridgedBy = new Map(liveRows(bridged).map((r) => [r.slug, r]));
  const stablesBy = new Map(liveRows(stables).map((r) => [r.slug, r]));
  const cctpBy = new Map(liveRows(cctp).map((r) => [r.slug, r]));

  const rawChains = [...chainSlugs].map((slug) => {
    const ent = chainEntities.get(slug);
    const br = bridgedBy.get(slug);
    const st = stablesBy.get(slug);
    const row: Omit<ChainRow, "note" | "hasChainPage"> = {
      slug,
      name: CHAIN_NAME.get(slug) ?? br?.name ?? st?.name ?? slug,
      tvl: latest(ent, "tvl"),
      bridgedTvl: br ? num(br.ms.p50) : null,
      bridgedSharePct: panel(bridged, "bridged_share", slug),
      change7dPct: panel(bridged, "change_7d", slug),
      excess7dPct: panel(bridged, "excess_7d", slug),
      stablesFloat: panel(stables, "float_usd", slug) ?? latest(ent, "stables_mcap"),
      stablesNet30d: st ? num(st.ms.p50) : latest(ent, "stables_net_30d"),
      stablesChange30dPct: panel(stables, "change_30d", slug),
      stablesNet7d: panel(stables, "net_7d", slug),
      cctpNet7d: cctpBy.has(slug) ? num(cctpBy.get(slug)!.ms.p50) : null,
      cctpIn7d: panel(cctp, "inflow_7d", slug),
      cctpOut7d: panel(cctp, "outflow_7d", slug),
      dexVolume24h: latest(ent, "dex_volume_24h"),
      nativeMcap: latest(ent, "native_mcap"),
      fees30d: latest(ent, "fees_30d"),
      revenue30d: latest(ent, "revenue_30d"),
    };
    return row;
  });
  const stableLeaderSlug = [...rawChains]
    .filter((c) => c.stablesNet30d != null)
    .sort((a, b) => (b.stablesNet30d ?? 0) - (a.stablesNet30d ?? 0))[0]?.slug;
  const excessLeaderSlug = [...rawChains]
    .filter((c) => c.excess7dPct != null)
    .sort((a, b) => (b.excess7dPct ?? 0) - (a.excess7dPct ?? 0))[0]?.slug;
  const chains: ChainRow[] = rawChains
    .filter((c) => c.tvl != null || c.bridgedTvl != null || c.stablesNet30d != null || c.stablesFloat != null)
    .map((c) => ({
      ...c,
      note: chainNote(c, c.slug === stableLeaderSlug, c.slug === excessLeaderSlug),
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
      const base: Omit<ProtocolRow, "note" | "hasProductPage" | "signal"> = {
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
      return { ...base, signal, note: protocolNote(base), hasProductPage: getProviderRegistry(r.slug) !== undefined };
    })
    .filter((r) => r.pf != null && r.pf > 0)
    .sort((a, b) => (a.pf ?? 0) - (b.pf ?? 0));

  // ---- valuation: perps -------------------------------------------------
  const perps: PerpRow[] = liveRows(perpsB)
    .map((r) => {
      const base: Omit<PerpRow, "note" | "hasProductPage"> = {
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
      return { ...base, note: perpNote(base), hasProductPage: getProviderRegistry(r.slug) !== undefined };
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
