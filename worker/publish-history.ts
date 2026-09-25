/**
 * Daily capital and valuation history, published as two static JSON blobs
 * next to the aggregate (served by Caddy at kv.openchainbench.com/aggregate/):
 *
 *   valuation/history.json  one point per UTC day per protocol: market cap,
 *                           FDV, float, 30d fees, 30d revenue, P/F, P/S, OI,
 *                           30d price change. Two cohorts: `protocols` (bench
 *                           274, cross-DeFi, fees only) and `perps` (bench 265,
 *                           fees and revenue).
 *   chains/history.json     one point per UTC day per chain: TVL, bridged TVL,
 *                           value secured, stablecoin mcap and 30d net flow,
 *                           native token mcap, 24h DEX volume, and the chain
 *                           fees / revenue gauges once the chain-kpis harness
 *                           publishes them.
 *
 * Why: Prometheus keeps 365 days but the public surfaces cap range queries at
 * days (query_prom) or at the bench's first scrape (/api/series), so a
 * "revenue up, token down over six months" chart had nowhere to read from.
 * The worker already reaches Prom every sweep; once every HISTORY_EVERY_MIN
 * it upserts today's point for every entity and rewrites the blob. Today's
 * point is overwritten on each run (the gauges move intraday) and becomes
 * final at midnight UTC. Nothing is backfilled: the series start the day this
 * shipped. Entities keep at most HISTORY_DAYS points.
 *
 * Readers: src/lib/capital-history.ts (site), and anyone with the URL.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Prometheus } from "@/lib/prometheus";

const HISTORY_DAYS = 400;
const HISTORY_EVERY_MS = Number(process.env.HISTORY_EVERY_MIN ?? 30) * 60_000;

type Point = Record<string, number | string>;
type Entity = { slug: string; days: Point[]; [k: string]: unknown };

type Blob = {
  generated_at: string;
  days_kept: number;
  source: string;
  [cohort: string]: unknown;
};

let lastRunMs = 0;

async function atomicWrite(finalPath: string, body: string): Promise<void> {
  // Per-process temp name: two workers alive during a rebuild must not
  // rename each other's half-written file into place.
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, body, "utf-8");
    await rename(tmpPath, finalPath);
  } catch (err) {
    // Never leave a half file in a directory Caddy serves.
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

/**
 * The previous blob, or null when the file does not exist yet. Any other
 * failure (unreadable, unparsable) throws, so the caller skips this run
 * instead of replacing 400 days of history with today's point.
 */
async function readBlob(path: string): Promise<Blob | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as Blob;
  if (!parsed || typeof parsed !== "object") throw new Error(`${path}: not an object`);
  return parsed;
}

/** A cohort read from the previous blob: an array, or absent on a fresh file. */
function previousCohort(blob: Blob | null, key: string, path: string): unknown[] | undefined {
  if (!blob) return undefined;
  const v = blob[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error(`${path}: cohort ${key} is not an array`);
  return v;
}

/**
 * One instant vector as { labelValue: number }. Throws on a failed query:
 * a cohort with one failed field is not written this run (the previous
 * file stands) rather than written short of that field.
 */
async function vector(
  prom: Prometheus,
  promql: string,
  label: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const res = await prom.query(promql);
  if (res.resultType !== "vector") return out;
  for (const r of res.result) {
    const key = r.metric[label];
    const v = Number(r.value[1]);
    if (key && Number.isFinite(v)) out.set(key, v);
  }
  return out;
}

/** Label pairs of an info-style gauge: { slug: { name, category } }. */
async function infoLabels(
  prom: Prometheus,
  promql: string,
  keyLabel: string,
  labels: string[],
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  try {
    const res = await prom.query(promql);
    if (res.resultType !== "vector") return out;
    for (const r of res.result) {
      const key = r.metric[keyLabel];
      if (!key) continue;
      const picked: Record<string, string> = {};
      for (const l of labels) if (r.metric[l]) picked[l] = r.metric[l];
      out.set(key, picked);
    }
  } catch {
    // info gauge missing: names fall back to the slug
  }
  return out;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Upsert `point` (keyed by point.day) into an entity's days, keep the last
 * HISTORY_DAYS. An existing day is merged, not replaced: a gauge the harness
 * dropped between two runs (undefined denominator, restart) must not erase
 * the value recorded earlier that day.
 */
function upsert(entity: Entity, point: Point): void {
  const day = point.day as string;
  const i = entity.days.findIndex((p) => p.day === day);
  if (i >= 0) entity.days[i] = { ...entity.days[i], ...point };
  else entity.days.push(point);
  entity.days.sort((a, b) => String(a.day).localeCompare(String(b.day)));
  if (entity.days.length > HISTORY_DAYS) entity.days.splice(0, entity.days.length - HISTORY_DAYS);
}

/** Merge today's values into a cohort array of entities, creating entities on first sight. */
function mergeCohort(
  existing: unknown,
  keys: Iterable<string>,
  pointFor: (slug: string) => Point | null,
  meta: (slug: string) => Record<string, unknown | undefined>,
): Entity[] {
  const bySlug = new Map<string, Entity>();
  if (Array.isArray(existing)) {
    for (const e of existing) {
      if (e && typeof e === "object" && typeof (e as Entity).slug === "string") {
        const ent = e as Entity;
        bySlug.set(ent.slug, { ...ent, days: Array.isArray(ent.days) ? ent.days : [] });
      }
    }
  }
  for (const slug of keys) {
    const point = pointFor(slug);
    if (!point) continue;
    const ent = bySlug.get(slug) ?? { slug, days: [] };
    // Meta (name, category) only when this run has it; a missing info
    // gauge must not reset names already stored.
    for (const [k, v] of Object.entries(meta(slug))) if (v !== undefined) ent[k] = v;
    upsert(ent, point);
    bySlug.set(slug, ent);
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function pick(day: string, fields: Record<string, Map<string, number>>, slug: string): Point | null {
  const point: Point = { day };
  let any = false;
  for (const [field, m] of Object.entries(fields)) {
    const v = m.get(slug);
    if (v !== undefined) {
      point[field] = v;
      any = true;
    }
  }
  return any ? point : null;
}

async function publishValuation(prom: Prometheus, dir: string, day: string): Promise<number> {
  // Bench 274 cohort (cross-DeFi, fees only).
  const p = {
    mcap: await vector(prom, "protocol_mcap_usd", "protocol"),
    fdv: await vector(prom, "protocol_fdv_usd", "protocol"),
    float_pct: await vector(prom, "protocol_float_pct", "protocol"),
    fees_30d: await vector(prom, "protocol_fees_30d_usd", "protocol"),
    pf: await vector(prom, "protocol_pf_ratio", "protocol"),
    pf_fdv: await vector(prom, "protocol_pf_fdv_ratio", "protocol"),
    price_change_30d_pct: await vector(prom, "protocol_price_change_30d_pct", "protocol"),
    fee_growth_30d_pct: await vector(prom, "protocol_fee_growth_30d_pct", "protocol"),
    // 1 when the fee adapter is knowably incomplete: the board holds the
    // token out and so should any reader of this file.
    fees_incomplete: await vector(prom, "protocol_fees_incomplete", "protocol"),
  };
  const pInfo = await infoLabels(prom, "protocol_info", "protocol", ["name", "category"]);
  // Bench 265 cohort (perp DEXes, fees and revenue).
  const x = {
    mcap: await vector(prom, "perp_protocol_mcap_usd", "protocol"),
    fdv: await vector(prom, "perp_protocol_fdv_usd", "protocol"),
    float_pct: await vector(prom, "perp_protocol_float_pct", "protocol"),
    fees_30d: await vector(prom, "perp_protocol_fees_30d_usd", "protocol"),
    rev_30d: await vector(prom, "perp_protocol_rev_30d_usd", "protocol"),
    pf: await vector(prom, "perp_protocol_pf_ratio", "protocol"),
    pf_fdv: await vector(prom, "perp_protocol_pf_fdv_ratio", "protocol"),
    ps: await vector(prom, "perp_protocol_ps_ratio", "protocol"),
    oi: await vector(prom, "perp_protocol_oi_usd", "protocol"),
  };
  const path = join(dir, "valuation", "history.json");
  const prev = await readBlob(path);
  const protocols = mergeCohort(
    previousCohort(prev, "protocols", path),
    new Set([...p.pf.keys(), ...p.mcap.keys()]),
    (slug) => pick(day, p, slug),
    (slug) => ({ name: pInfo.get(slug)?.name, category: pInfo.get(slug)?.category }),
  );
  const perps = mergeCohort(
    previousCohort(prev, "perps", path),
    new Set([...x.pf.keys(), ...x.mcap.keys()]),
    (slug) => pick(day, x, slug),
    () => ({}),
  );
  const blob: Blob = {
    generated_at: new Date().toISOString(),
    days_kept: HISTORY_DAYS,
    source:
      "OpenChainBench valuation harnesses (DeFiLlama fees/revenue, CoinGecko market data), one point per UTC day, today's point overwritten until midnight UTC. Benches 274 (protocols) and 265 (perps). CC-BY-4.0.",
    protocols,
    perps,
  };
  await mkdir(join(dir, "valuation"), { recursive: true });
  await atomicWrite(path, JSON.stringify(blob));
  return protocols.length + perps.length;
}

async function publishChains(prom: Prometheus, dir: string, day: string): Promise<number> {
  const c = {
    tvl: await vector(prom, "chain_tvl_usd", "chain"),
    bridged_tvl: await vector(prom, "chain_bridged_tvl_usd", "chain"),
    tvs: await vector(prom, "chain_tvs_usd", "chain"),
    stables_mcap: await vector(prom, "chain_stables_mcap_usd", "chain"),
    stables_net_30d: await vector(prom, "chain_stables_net_30d_usd", "chain"),
    native_mcap: await vector(prom, "max by (chain) (chain_native_mcap_usd)", "chain"),
    dex_volume_24h: await vector(prom, "chain_dex_volume_24h_usd", "chain"),
    // Published by the chain-kpis harness from the chain fees bench on;
    // absent until then and simply not written.
    fees_30d: await vector(prom, "chain_fees_30d_usd", "chain"),
    revenue_30d: await vector(prom, "chain_revenue_30d_usd", "chain"),
  };
  const path = join(dir, "chains", "history.json");
  const prev = await readBlob(path);
  const keys = new Set<string>();
  for (const m of Object.values(c)) for (const k of m.keys()) keys.add(k);
  const chains = mergeCohort(previousCohort(prev, "chains", path), keys, (slug) => pick(day, c, slug), () => ({}));
  const blob: Blob = {
    generated_at: new Date().toISOString(),
    days_kept: HISTORY_DAYS,
    source:
      "OpenChainBench chain-kpis harness (DeFiLlama TVL, stablecoins and DEX volume; L2Beat value secured; Mobula native token market cap), one point per UTC day, today's point overwritten until midnight UTC. Benches 273 and 275. CC-BY-4.0.",
    chains,
  };
  await mkdir(join(dir, "chains"), { recursive: true });
  await atomicWrite(path, JSON.stringify(blob));
  return chains.length;
}

/**
 * Called once per worker sweep; does the work at most every HISTORY_EVERY_MIN.
 * No-op when AGGREGATE_OUTPUT_PATH or PROMETHEUS_URL is unset.
 */
export async function publishCapitalHistory(): Promise<void> {
  const dir = process.env.AGGREGATE_OUTPUT_PATH;
  const promUrl = process.env.PROMETHEUS_URL;
  if (!dir || !promUrl) return;
  const now = Date.now();
  if (now - lastRunMs < HISTORY_EVERY_MS) return;
  lastRunMs = now;
  const t0 = Date.now();
  try {
    const prom = new Prometheus(promUrl);
    const day = todayUtc();
    // Each cohort independently: a failed query or an unreadable file on
    // one side leaves that file untouched and lets the other publish.
    const [v, c] = await Promise.allSettled([
      publishValuation(prom, dir, day),
      publishChains(prom, dir, day),
    ]);
    const describe = (r: PromiseSettledResult<number>, what: string) =>
      r.status === "fulfilled" ? `${r.value} ${what}` : `${what} skipped: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
    console.log(
      `[worker] capital history in ${((Date.now() - t0) / 1000).toFixed(1)}s (${describe(v, "valuation entities")}, ${describe(c, "chains")}, day ${day})`,
    );
  } catch (err) {
    console.warn(
      `[worker] capital history failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
