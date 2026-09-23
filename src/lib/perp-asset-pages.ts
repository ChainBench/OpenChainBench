/**
 * Per-asset perp pages (/perps/eth, /perps/btc, /perps/sol): for one
 * underlying, every venue's all-in opening cost, slippage at $100k,
 * taker fee and funding over 24h, 7d and 30d, side by side. The three
 * assets are the ones the perp-fees harness walks and the funding feeds
 * cover on every venue; more assets need harness work first.
 *
 * Data path mirrors perp-stats.ts: the worker (in-network Prom) builds
 * the snapshot with fetchPerpAssetPagesFresh and writes it under
 * PERP_ASSET_PAGES_KEY; Vercel readers get the blob through
 * fetchPerpAssetPages (snapshot-first, unstable_cache). Prom is not
 * reachable from Vercel, so the live path only runs on the worker.
 */
import { unstable_cache } from "next/cache";
import { Prometheus } from "@/lib/prometheus";
import { readCohortSnapshot, writeCohortSnapshot } from "@/lib/cohort-snapshot";
import { PERP_VENUES, promUrl } from "@/lib/perp-stats";
import { PERP_VENUE_META } from "@/lib/perp-venue-context";

export const PERP_ASSET_PAGES_KEY = "perp-asset-pages";

export type PerpAssetCode = "ETH" | "BTC" | "SOL";

export const PERP_ASSETS: { slug: string; asset: PerpAssetCode; name: string }[] = [
  { slug: "eth", asset: "ETH", name: "Ethereum" },
  { slug: "btc", asset: "BTC", name: "Bitcoin" },
  { slug: "sol", asset: "SOL", name: "Solana" },
];

export function perpAssetBySlug(slug: string) {
  return PERP_ASSETS.find((a) => a.slug === slug.toLowerCase()) ?? null;
}

export type PerpAssetVenueRow = {
  slug: string;
  name: string;
  /** /products/<productSlug> (gmx-v2 -> gmx, trade-xyz -> xyz). */
  productSlug: string;
  venueType: "onchain" | "regulated" | "cex";
  /** perp-fees: all-in bps to open a $1k long (taker + half spread + impact), 24h avg. */
  allInBps: number | null;
  /** perp-fees: taker fee bps, 24h avg. */
  takerFeeBps: number | null;
  /** perp-fees tiers: slippage bps of a $100k market buy, fee excluded, 24h avg.
   *  Null when the book filled $100k on fewer than 90 % of the ticks (the
   *  tier series only exists on filled ticks, so its average would be the
   *  venue's deep hours only). */
  slippage100kBps: number | null;
  /** Share of 24h ticks where the $100k tier was filled (0 to 1). */
  slippage100kFill: number | null;
  /** Funding cost in bps to hold a long: 24h at the current rate (24h avg),
   *  and a week or a month at the average daily cost over the trailing 7
   *  and 30 days (average x 7, average x 30). Signed, positive means longs
   *  pay. funding30dSamples says how many hours are behind the month. */
  funding24hBps: number | null;
  funding7dBps: number | null;
  funding30dBps: number | null;
  /** Hourly samples behind funding30dBps (720 for a full month). Under
   *  FULL_MONTH_MIN the month is extrapolated from a shorter window (the
   *  venue joined recently, or its feed dropped hours) and the page marks
   *  the day count. */
  funding30dSamples: number | null;
};

export type PerpAssetPageData = {
  asset: PerpAssetCode;
  venues: PerpAssetVenueRow[];
  /** CEX funding for context, same fields, no fees (not measured there). */
  cex: PerpAssetVenueRow[];
};

export type PerpAssetPagesSnapshot = {
  assets: Record<PerpAssetCode, PerpAssetPageData>;
  asOf: number;
};

const CEX_FUNDING_VENUES: Record<string, string> = {
  binance: "Binance",
  bybit: "Bybit",
  okx: "OKX",
  coinbase: "Coinbase International",
  kraken: "Kraken",
  bitget: "Bitget",
  gate: "Gate",
  kucoin: "KuCoin",
  mexc: "MEXC",
  deribit: "Deribit",
};

const ASSETS_RE = `asset=~"BTC|ETH|SOL"`;
const CHAINS_RE = `chain=~"BTC|ETH|SOL"`;

type Sample = { labels: Record<string, string>; value: number };

async function queryVector(prom: Prometheus, promql: string): Promise<Sample[]> {
  try {
    const res = await prom.query(promql);
    if (res.resultType !== "vector") return [];
    return res.result
      .map((r) => ({ labels: r.metric, value: Number(r.value[1]) }))
      .filter((s) => Number.isFinite(s.value));
  } catch {
    return [];
  }
}

/** The perp-fees harness labels GMX "gmx"; the cohort uses "gmx-v2". */
function venueSlug(label: string): string {
  return label === "gmx" ? "gmx-v2" : label;
}

export async function fetchPerpAssetPagesFresh(): Promise<PerpAssetPagesSnapshot | null> {
  const url = promUrl();
  if (!url) return null;
  let prom: Prometheus;
  try {
    prom = new Prometheus(url);
  } catch {
    return null;
  }

  // Funding: the cohort feed and the perp-funding bench feed, merged per
  // (venue, asset) below. 7d and 30d are the daily cost averaged over the
  // window times the days in the window: a week or a month of funding at
  // the average daily cost actually quoted (same rule as bench
  // perp-funding-cost-30d). A total over the days measured would rank on
  // coverage: a venue that lost five days to an outage would beat an
  // identical one on the missing days alone (review 2026-09-23).
  // The 7d and 30d windows are read on an hourly grid ([w:1h]): 720
  // points per series instead of 43,200 minutes, so the query stays well
  // inside the client's 10 s timeout. The sample count travels with the
  // 30d figure so the page can mark a window shorter than the month.
  // Two funding feeds, queried apart and merged cohort-first below: a
  // PromQL `or` keeps both when their label sets differ (the perp-funding
  // bench series carry extra labels), which duplicated Binance and OKX.
  const normalised = (metric: string, w: string, days: number) => {
    const sel = `${metric}{${ASSETS_RE}}[${w}:1h]`;
    return `avg_over_time(${sel}) * ${days}`;
  };
  const feeds = ["perp_venue_funding_24h_bps", "perp_funding_hold_24h_bps"] as const;
  const [[f24a, f24b], [f7a, f7b], [f30a, f30b], [n30a, n30b], allIn, taker, tier100k, fill100k] = await Promise.all([
    Promise.all(feeds.map((m) => queryVector(prom, `avg_over_time(${m}{${ASSETS_RE}}[24h])`))),
    Promise.all(feeds.map((m) => queryVector(prom, normalised(m, "7d", 7)))),
    Promise.all(feeds.map((m) => queryVector(prom, normalised(m, "30d", 30)))),
    Promise.all(feeds.map((m) => queryVector(prom, `count_over_time(${m}{${ASSETS_RE}}[30d:1h])`))),
    queryVector(prom, `avg_over_time(perp_fees_all_in_bps{${CHAINS_RE}}[24h])`),
    queryVector(prom, `avg_over_time(perp_fees_taker_fee_bps{${CHAINS_RE}}[24h])`),
    queryVector(
      prom,
      `avg_over_time(perp_fees_all_in_bps_tier{${CHAINS_RE},notional="100000"}[24h]) - ignoring(notional) avg_over_time(perp_fees_taker_fee_bps{${CHAINS_RE}}[24h])`,
    ),
    // Share of ticks where the $100k tier was filled. The tier gauge is
    // deleted on ticks the book could not absorb $100k, so its average is
    // the venue's deep hours only; below 90 % the slippage figure is not
    // published for the venue.
    queryVector(
      prom,
      `count_over_time(perp_fees_all_in_bps_tier{${CHAINS_RE},notional="100000"}[24h]) / ignoring(notional) count_over_time(perp_fees_all_in_bps{${CHAINS_RE}}[24h])`,
    ),
  ]);
  // Every block has to answer; a timed-out 30d query would otherwise
  // publish a complete-looking snapshot with a column of nulls and the
  // previous good blob would be replaced by it.
  // Two funding feeds per (venue, asset): the cohort harness and the
  // perp-fees bench. The one with the longer 30d history wins the four
  // funding cells, the other fills what it lacks. A venue that gains a
  // native cohort feed (Aster, 2026-09-23) keeps its month of bench
  // history until the native series has more samples than the bench one.
  const fundingFeeds = [
    { f24: f24a, f7: f7a, f30: f30a, n30: n30a },
    { f24: f24b, f7: f7b, f30: f30b, n30: n30b },
  ];
  if (f24a.length === 0 || allIn.length === 0 || f30a.length === 0 || f7a.length === 0) return null;

  const assets: PerpAssetCode[] = ["ETH", "BTC", "SOL"];
  const out = {} as Record<PerpAssetCode, PerpAssetPageData>;
  for (const asset of assets) {
    const rows = new Map<string, PerpAssetVenueRow>();
    const blank = (slug: string, name: string, venueType: PerpAssetVenueRow["venueType"]): PerpAssetVenueRow => ({
      slug,
      name,
      productSlug: PERP_VENUE_META[slug]?.productSlug ?? slug,
      venueType,
      allInBps: null,
      takerFeeBps: null,
      slippage100kBps: null,
      slippage100kFill: null,
      funding24hBps: null,
      funding7dBps: null,
      funding30dBps: null,
      funding30dSamples: null,
    });
    for (const v of PERP_VENUES) rows.set(v.slug, blank(v.slug, v.name, v.venueType));
    // The registry row wins the display name (Coinbase International on
    // the hub and here alike); the map only covers a CEX the registry lacks.
    for (const [slug, name] of Object.entries(CEX_FUNDING_VENUES)) if (!rows.has(slug)) rows.set(slug, blank(slug, name, "cex"));

    // First writer wins: samples are ordered cohort feed then bench feed.
    const put = (samples: Sample[], labelKey: "asset" | "chain", field: keyof PerpAssetVenueRow) => {
      for (const s of samples) {
        if (s.labels[labelKey] !== asset) continue;
        const row = rows.get(venueSlug(s.labels.venue ?? ""));
        if (!row) continue;
        const target = row as unknown as Record<string, number | null>;
        if (target[field] == null) target[field] = s.value;
      }
    };
    const pick = (samples: Sample[], slug: string): number | null =>
      samples.find((s) => s.labels.asset === asset && venueSlug(s.labels.venue ?? "") === slug)?.value ?? null;
    for (const row of rows.values()) {
      const nA = pick(fundingFeeds[0].n30, row.slug) ?? 0;
      const nB = pick(fundingFeeds[1].n30, row.slug) ?? 0;
      const order = nB > nA ? [fundingFeeds[1], fundingFeeds[0]] : [fundingFeeds[0], fundingFeeds[1]];
      for (const fd of order) {
        if (row.funding24hBps == null) row.funding24hBps = pick(fd.f24, row.slug);
        if (row.funding7dBps == null) row.funding7dBps = pick(fd.f7, row.slug);
        if (row.funding30dBps == null) {
          row.funding30dBps = pick(fd.f30, row.slug);
          if (row.funding30dBps != null) row.funding30dSamples = pick(fd.n30, row.slug);
        }
      }
    }
    put(allIn, "chain", "allInBps");
    put(taker, "chain", "takerFeeBps");
    put(tier100k, "chain", "slippage100kBps");
    put(fill100k, "chain", "slippage100kFill");
    for (const r of rows.values()) {
      if (r.slippage100kBps != null && (r.slippage100kFill ?? 0) < 0.9) r.slippage100kBps = null;
    }

    const has = (r: PerpAssetVenueRow) =>
      r.allInBps != null || r.funding24hBps != null || r.slippage100kBps != null;
    const all = [...rows.values()].filter(has);
    out[asset] = {
      asset,
      venues: all.filter((r) => r.venueType !== "cex"),
      cex: all.filter((r) => r.venueType === "cex"),
    };
  }
  return { assets: out, asOf: Math.floor(Date.now() / 1000) };
}

async function fetchPerpAssetPagesRaw(): Promise<PerpAssetPagesSnapshot | null> {
  const snapshot = await readCohortSnapshot<PerpAssetPagesSnapshot>(PERP_ASSET_PAGES_KEY);
  if (snapshot && snapshot.ageMs < 2 * 60 * 1000 && snapshot.data?.assets) {
    return snapshot.data;
  }
  const fresh = await fetchPerpAssetPagesFresh();
  if (fresh) {
    try {
      await writeCohortSnapshot(PERP_ASSET_PAGES_KEY, fresh);
    } catch (err) {
      console.warn(`perp-asset-pages writeback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return fresh;
  }
  if (snapshot && snapshot.ageMs < 10 * 60 * 1000 && snapshot.data?.assets) {
    console.warn(`perp-asset-pages: serving stale snapshot (${Math.round(snapshot.ageMs / 1000)}s old)`);
    return snapshot.data;
  }
  return null;
}

const fetchPerpAssetPagesCached = unstable_cache(
  async () => {
    const data = await fetchPerpAssetPagesRaw();
    if (!data) throw new Error("perp-asset-pages-unavailable");
    return data;
  },
  ["perp-asset-pages-v1"],
  { revalidate: 300, tags: ["perp-asset-pages"] },
);

export async function fetchPerpAssetPages(): Promise<PerpAssetPagesSnapshot | null> {
  try {
    return await fetchPerpAssetPagesCached();
  } catch {
    return null;
  }
}

export async function fetchPerpAssetPage(asset: PerpAssetCode): Promise<{ data: PerpAssetPageData; asOf: number } | null> {
  const snap = await fetchPerpAssetPages();
  if (!snap) return null;
  const data = snap.assets[asset];
  return data ? { data, asOf: snap.asOf } : null;
}

/** Sort for the venue table: venues with a measured all-in cost first,
 *  cheapest first; then venues with funding only, cheapest to hold. */
export function sortPerpAssetRows(rows: PerpAssetVenueRow[]): PerpAssetVenueRow[] {
  return [...rows].sort((a, b) => {
    if (a.allInBps != null && b.allInBps != null) return a.allInBps - b.allInBps;
    if (a.allInBps != null) return -1;
    if (b.allInBps != null) return 1;
    const fa = a.funding24hBps ?? Number.POSITIVE_INFINITY;
    const fb = b.funding24hBps ?? Number.POSITIVE_INFINITY;
    return fa - fb || a.name.localeCompare(b.name);
  });
}
