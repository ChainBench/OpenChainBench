/**
 * Oracle-deviation per-source-pair breakdown.
 *
 * GET /api/bench/oracle-deviation/oracle-pairs
 *
 * Returns the p50 (24h) deviation between every (source_a, source_b) pair
 * for every asset pair the bench tracks. Powers the "View by oracle pair"
 * pivot on the oracle-deviation page — same number as the leaderboard
 * (time-aligned, ocb_oracle_deviation_at_oracle_ts_pct), but disaggregated
 * by the source pair that produced it so a reader can answer "which two
 * oracles disagree most on SOL?" instead of just "max disagreement on SOL".
 */

import { NextResponse } from "next/server";
import { Prometheus } from "@/lib/prometheus";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const revalidate = 60;

type Params = { slug: string };

type OraclePairRow = {
  asset: string;
  cells: Record<string, number | null>;
};

type Payload = {
  sources: string[];
  oraclePairs: string[];
  rows: OraclePairRow[];
  dataAsOf: number | null;
};

const SOURCE_ORDER = ["chainlink", "pyth", "binance", "coinbase"];

function orderPair(a: string, b: string): string {
  return [a, b].sort().join("-");
}

export async function GET(
  req: Request,
  { params }: { params: Promise<Params> },
) {
  const r = rateLimit(clientKey(req, "oracle-pairs"), 60, 60);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const { slug } = await params;
  // The breakdown only exists for the oracle-deviation bench. Other
  // slugs 404 so a stray fetch (eg. a copy-pasted URL on a different
  // bench) doesn't pull unrelated metrics from Prom.
  if (slug !== "oracle-deviation") {
    return new NextResponse("not found", {
      status: 404,
      headers: { "cache-control": "public, s-maxage=60" },
    });
  }

  const promUrl = process.env.PROMETHEUS_URL?.trim();
  if (!promUrl) {
    return NextResponse.json(
      { error: "prometheus_not_configured" },
      { status: 503 },
    );
  }

  let prom: Prometheus;
  try {
    prom = new Prometheus(promUrl);
  } catch {
    return NextResponse.json(
      { error: "prometheus_misconfigured" },
      { status: 503 },
    );
  }

  // One instant query returns every (pair, source_a, source_b) series.
  // quantile_over_time matches the leaderboard's p50/24h semantics.
  // No "* 100" here: the harness stores the gauge directly in percent
  // (e.g. 0.0608 = 0.0608% deviation), so the value flows straight to
  // the UI as a percent number. The leaderboard's YAML uses "* 100" to
  // present in bps with a different formatter — we want raw % here.
  const query =
    "quantile_over_time(0.5, ocb_oracle_deviation_at_oracle_ts_pct[24h])";
  let result;
  try {
    result = await prom.query(query);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "prometheus_query_failed", detail: reason.slice(0, 200) },
      { status: 502 },
    );
  }

  if (result.resultType !== "vector") {
    return NextResponse.json({ error: "unexpected_result_type" }, { status: 502 });
  }

  // Group by asset pair → oracle pair → value.
  const byAsset: Record<string, Map<string, number>> = {};
  const seenSources = new Set<string>();
  const seenOraclePairs = new Set<string>();

  for (const v of result.result) {
    const asset = v.metric.pair;
    const sa = v.metric.source_a;
    const sb = v.metric.source_b;
    if (!asset || !sa || !sb) continue;
    const num = Number(v.value[1]);
    if (!Number.isFinite(num)) continue;
    seenSources.add(sa);
    seenSources.add(sb);
    const key = orderPair(sa, sb);
    seenOraclePairs.add(key);
    if (!byAsset[asset]) byAsset[asset] = new Map();
    byAsset[asset].set(key, num);
  }

  const sources = SOURCE_ORDER.filter((s) => seenSources.has(s));
  // Deterministic oracle-pair ordering: every (a,b) where a < b in
  // SOURCE_ORDER. Keeps the grid columns stable across renders even if
  // Prom returns the vector in a different order from one scrape to the
  // next.
  const oraclePairs: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const key = orderPair(sources[i], sources[j]);
      if (seenOraclePairs.has(key)) oraclePairs.push(key);
    }
  }

  const rows: OraclePairRow[] = Object.keys(byAsset)
    .sort()
    .map((asset) => {
      const m = byAsset[asset];
      const cells: Record<string, number | null> = {};
      for (const p of oraclePairs) {
        cells[p] = m.has(p) ? Number(m.get(p)!.toPrecision(6)) : null;
      }
      return { asset, cells };
    });

  // Best-effort freshness: same dataAgeSec helper the rest of the site
  // uses. Cheap (single Prom instant query) and matches LiveIndicator.
  let dataAsOf: number | null = null;
  try {
    const ageSec = await prom.dataAgeSec(
      "ocb_oracle_deviation_at_oracle_ts_pct",
    );
    if (ageSec != null && Number.isFinite(ageSec) && ageSec >= 0) {
      dataAsOf = Date.now() - Math.floor(ageSec * 1000);
    }
  } catch {
    // ignore — data still returnable without an exact timestamp
  }

  const payload: Payload = { sources, oraclePairs, rows, dataAsOf };
  return NextResponse.json(payload, {
    headers: {
      "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
