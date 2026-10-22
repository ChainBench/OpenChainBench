/**
 * Materialization worker. Runs on Railway next to the Prometheus, loops
 * forever:
 *   tier A (every SWEEP_SEC, default 60s): every unfiltered bench
 *   tier B (every VARIANT_EVERY sweeps, default 5): every chain/region/kind
 *           variant combo of every dimensioned bench
 *
 * For each (bench, variant) it runs the same loader the site used to run
 * at request time, merges the result with carry-forward state (a provider
 * whose queries failed this sweep keeps its last good values + staleSince
 * marker, and its last good series), and publishes an atomic snapshot to
 * the store. The site then only ever reads complete snapshots.
 *
 * Run from the repo root: `pnpm worker` (tsx resolves the @/ alias via
 * the root tsconfig). Env: PROMETHEUS_URL, KV_REST_API_URL/TOKEN.
 *
 * Fail-soft by design: worker dies → site serves the last snapshots,
 * frozen but complete; the heartbeat key surfaces the outage.
 */

import {
  loadSpecsUncached,
  specToBenchmark,
  defaultTier,
  filterSig,
  type BenchmarkFilters,
} from "@/lib/materialize/load";
import { mergeWithPrevious } from "./merge";
import {
  MAT_SCHEMA_VERSION,
  RING_CADENCE,
  type MaterializedSnapshot,
  type SeriesRing,
  type StalenessMeta,
  type WorkerState,
} from "@/lib/materialize/schema";
import {
  heartbeat,
  publishSnapshot,
  readMaterialized,
  storeConfigured,
  touchSnapshot,
} from "@/lib/materialize/store";
import {
  cohortSnapshotConfigured,
  writeCohortSnapshot,
} from "@/lib/cohort-snapshot";
import { fetchPerpCohortFresh,
  fetchPerpByAssetMatrixFresh } from "@/lib/perp-stats";
import { fetchPerpAssetPagesFresh, PERP_ASSET_PAGES_KEY } from "@/lib/perp-asset-pages";
import {
  fetchHlBuilderStatsFresh,
  fetchHlCohortFresh,
  fetchHlHip3CohortFresh,
  fetchHlHistoryFresh,
  HL_FRONTENDS_KEY,
  hlBuilderKey,
  HL_HIP3_KEY,
  HL_HISTORY_KEY,
} from "@/lib/hl-builder-stats";
import { fetchPmCohortFresh } from "@/lib/pm-stats";
import { buildRpcHubSnapshotFresh, RPC_HUB_KEY } from "@/lib/rpc-hub-stats";
import { fetchChainKpisFresh } from "@/lib/chain-kpis";
import { CHAINS } from "@/lib/chains";
import { buildFeaturedLeadersFromStore } from "@/lib/search-featured";
import type { Benchmark, MetricPanel } from "@/types/benchmark";
import type { Spec } from "@/lib/spec-schema";
import { variantCombos } from "./variant-combos";
export { variantCombos };
import { publishAggregate, publishVariants, publishSitemapSlim } from "./publish-aggregate";
import { publishCapitalHistory } from "./publish-history";

const SWEEP_SEC = Number(process.env.SWEEP_SEC ?? 60);
const VARIANT_EVERY = Number(process.env.VARIANT_EVERY ?? 5);
/** Benches materialized concurrently. The Prom client's own 64-slot
 *  query semaphore is global, so this only bounds per-bench overhead. */
const BENCH_CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 3);



async function materializeOne(
  spec: Spec,
  filters: BenchmarkFilters,
): Promise<void> {
  const sig = filterSig(filters);
  const t0 = Date.now();
  // Read the previous snapshot: it carries both bench and state, and
  // survives worker restarts (one pointer + one blob GET).
  const prev = await readMaterialized(spec.slug, sig);

  const fresh = await specToBenchmark(spec, filters);
  if (spec.status === "live" && fresh.status === "draft") {
    // Total collapse this sweep. Never overwrite good data with a draft;
    // the previous snapshot simply ages (staleness surfaces it).
    if (prev) {
      console.warn(`[worker] ${spec.slug}/${sig || "all"} collapsed, keeping previous snapshot`);
      // Keep the kept snapshot alive: refresh its safety-net TTL so a
      // bench that stays broken does not lose its carried data when the
      // blob would otherwise expire.
      await touchSnapshot(spec.slug, sig).catch(() => {});
      return;
    }
    // No previous snapshot: publish the draft honestly (first boot during
    // a blackout); it gets replaced on the first good sweep.
  }

  const now = Date.now();
  const { bench, state } = mergeWithPrevious(
    fresh,
    prev,
    now,
    new Set(spec.providers.map((p) => p.slug)),
    spec.prometheus?.expected_freshness_seconds,
    // A filtered view's load is the answer: sig is empty only for the
    // unfiltered board, where the carry still protects a brownout.
    sig !== "",
  );

  const snap: MaterializedSnapshot = {
    v: MAT_SCHEMA_VERSION,
    slug: spec.slug,
    sig,
    builtAt: now,
    sweepMs: now - t0,
    bench,
    state,
  };
  await publishSnapshot(snap);
}


async function inBatches<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += n) {
    await Promise.allSettled(items.slice(i, i + n).map(fn));
  }
}

// ─── Self-alerting ───────────────────────────────────────────────────
// The worker is the only writer; if its writes start failing (store
// full, creds rotated, Upstash down) the site silently falls back to
// the live path and NOBODY notices — that exact failure ran 10 hours
// unnoticed on 2026-06-12 (quota blowout). Ping Slack after 3
// consecutive failed heartbeats, then hourly reminders while broken.
let writeFailStreak = 0;
async function slackPing(text: string): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!webhook) return;
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(8000),
  }).catch((e) => console.warn(`[worker] slack ping failed: ${e.message}`));
}
async function noteHeartbeat(ok: boolean, err?: unknown): Promise<void> {
  if (ok) {
    if (writeFailStreak >= 3) {
      await slackPing("✅ OCB materialize worker: store writes recovered");
    }
    writeFailStreak = 0;
    return;
  }
  writeFailStreak++;
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`[worker] heartbeat: ${detail}`);
  // Fire on the 3rd consecutive failure, then every ~60 sweeps (~1h).
  if (writeFailStreak === 3 || writeFailStreak % 60 === 0) {
    await slackPing(
      `🔴 OCB materialize worker: store writes failing for ${writeFailStreak} sweeps — site is serving the slow live fallback. Last error: ${detail.slice(0, 300)}`,
    );
  }
}

// ─── Site warming ────────────────────────────────────────────────────
// Low-traffic reality: almost every human visitor is the first visitor,
// and every deploy resets the site's ISR cache, so pages and variant
// combos are cold most of the time (1-7s renders behind a dimmed UI).
// After publishing fresh snapshots the worker pings the corresponding
// site URLs so the CDN always holds a warm copy. Gating is structural:
// if the worker dies, the pings die with it — the live fallback can
// never be stampeded by the warmer. Configure WARM_SITE_URLS with a
// comma-separated list (e.g. staging now, prod after the cutover).
const WARM_SITE_URLS = (process.env.WARM_SITE_URLS ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

async function warmUrls(paths: string[], label: string): Promise<void> {
  if (WARM_SITE_URLS.length === 0 || paths.length === 0) return;
  const t0 = Date.now();
  let ok = 0;
  let failed = 0;
  const urls = WARM_SITE_URLS.flatMap((base) => paths.map((p) => base + p));
  for (let i = 0; i < urls.length; i += 3) {
    await Promise.all(
      urls.slice(i, i + 3).map(async (url) => {
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(20_000),
            headers: { "User-Agent": "OpenChainBench-warmer/1.0" },
          });
          res.ok ? ok++ : failed++;
          // Drain so keep-alive sockets are reusable.
          await res.arrayBuffer().catch(() => {});
        } catch {
          failed++;
        }
      }),
    );
  }
  console.log(
    `[worker] warm ${label}: ${ok}/${urls.length} ok${failed ? ` (${failed} failed)` : ""} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

function variantPath(slug: string, f: BenchmarkFilters): string {
  const qs = new URLSearchParams();
  if (f.chain) qs.set("chain", f.chain);
  if (f.region) qs.set("region", f.region);
  if (f.kind) qs.set("kind", f.kind);
  if (f.venue) qs.set("venue", f.venue);
  if (f.tier) qs.set("tier", f.tier);
  return `/api/bench/${slug}/variant${qs.size ? `?${qs.toString()}` : ""}`;
}

async function sweep(iteration: number): Promise<void> {
  const specs = await loadSpecsUncached();
  const t0 = Date.now();
  // Heartbeat at sweep START so a long tier-B run (113+ variants × HL
  // frontends 104 builders, 2-4 min) doesn't make the watchdog scream
  // "stale" while the worker is healthy. The freshness watchdog now
  // means "worker hasn't started a sweep in N min".
  await heartbeat().then(
    () => noteHeartbeat(true),
    (e) => noteHeartbeat(false, e),
  );

  await inBatches(specs, BENCH_CONCURRENCY, async (spec) => {
    try {
      await materializeOne(spec, {});
    } catch (err) {
      console.warn(`[worker] tierA ${spec.slug}: ${err instanceof Error ? err.message : err}`);
    }
  });
  console.log(`[worker] tierA done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${specs.length} benches)`);
  await heartbeat().then(
    () => noteHeartbeat(true),
    (e) => noteHeartbeat(false, e),
  );

  // Broadcast the fresh aggregate to a static file that Caddy serves
  // publicly. The site then reads that URL from the CDN edge instead of
  // fanning out ~150 concurrent Redis GETs per homepage render. See
  // worker/publish-aggregate.ts for the full rationale. No-op when
  // AGGREGATE_OUTPUT_PATH is unset (staged rollout).
  let publishedBenches: Benchmark[] = [];
  if (process.env.AGGREGATE_OUTPUT_PATH) {
    const pubStart = Date.now();
    const result = await publishAggregate(specs);
    const elapsedSec = ((Date.now() - pubStart) / 1000).toFixed(1);
    if (result.ok) {
      console.log(
        `[worker] aggregate published in ${elapsedSec}s (${result.bytes} bytes, ${result.liveCount}/${result.total} live, revalidated=${result.revalidated})`,
      );
      publishedBenches = result.benches ?? [];
    } else {
      console.warn(
        `[worker] aggregate publish failed in ${elapsedSec}s: ${result.error}`,
      );
    }
  }

  // Daily capital and valuation history blobs (valuation/history.json,
  // chains/history.json). Throttled inside; see worker/publish-history.ts.
  await publishCapitalHistory();

  // Cohort snapshots used by the hub pages and the search dialog. Each
  // builder hits Prom directly (via the in-network http://ocb-prom:9090
  // URL), so they don't add load on the public reverse proxy. Failures
  // are isolated per blob — a bad perp fetch doesn't block the HL or
  // featured-leaders writes.
  if (cohortSnapshotConfigured()) {
    const cohortStart = Date.now();
    // Enumerate active HL builders once so per-builder dashboard jobs
    // (biggest day, milestones, coin shares, ...) can be scheduled next
    // to the cohort blob. Falls back to an empty list on brownout so a
    // dead Prom doesn't tear down the whole cohort sweep.
    const hlCohort = await fetchHlCohortFresh().catch(() => null);
    const hlBuilders = hlCohort?.rows.map((r) => r.slug) ?? [];
    const cohortJobs: Array<{
      key: string;
      build: () => Promise<unknown>;
    }> = [
      { key: "perp-cohort", build: () => fetchPerpCohortFresh() },
      { key: "perp-by-asset", build: () => fetchPerpByAssetMatrixFresh() },
      // /perps/eth, /perps/btc, /perps/sol: per-asset cost, slippage and
      // funding per venue, one blob for the three assets.
      { key: PERP_ASSET_PAGES_KEY, build: () => fetchPerpAssetPagesFresh() },
      // Keys are shared with the readers in hl-builder-stats so a shape
      // bump on one side (hl-hip3 -> hl-hip3-v2, 2026-09-24) cannot leave
      // the site reading a key the worker no longer writes.
      { key: HL_FRONTENDS_KEY, build: () => Promise.resolve(hlCohort) },
      { key: HL_HIP3_KEY, build: () => fetchHlHip3CohortFresh() },
      { key: HL_HISTORY_KEY, build: () => fetchHlHistoryFresh() },
      { key: "pm-hub", build: () => fetchPmCohortFresh() },
      // Cross-chain RPC hub (/rpc). Store-only builder: folds the
      // `-rpc` bench blobs this sweep just published into one snapshot,
      // so it must run AFTER the tier-A materialization above.
      { key: RPC_HUB_KEY, build: () => buildRpcHubSnapshotFresh() },
      { key: "search-featured", build: () => buildFeaturedLeadersFromStore() },
      // One blob per chain slug so a stale reading on one chain doesn't
      // pollute the others. Small enough that the Promise.allSettled loop
      // absorbs 20+ jobs without meaningful sweep-time overhead.
      ...CHAINS.map((c) => ({
        key: `chain-kpis:${c.slug}`,
        build: () => fetchChainKpisFresh(c.slug),
      })),
      // Per-builder dashboard payloads. Each fans out ~13 Prom queries,
      // so ~91 builders × 13 = ~1200 queries; the Prom client's 64-slot
      // global semaphore keeps the concurrency bounded and the whole
      // batch typically completes in a few seconds.
      ...hlBuilders.map((slug) => ({
        key: hlBuilderKey(slug),
        build: () => fetchHlBuilderStatsFresh(slug),
      })),
    ];
    const results = await Promise.allSettled(
      cohortJobs.map(async ({ key, build }) => {
        const blob = await build();
        if (!blob) throw new Error("builder returned null");
        await writeCohortSnapshot(key, blob);
        return key;
      }),
    );
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    const failures = results
      .map((r, i) =>
        r.status === "rejected"
          ? `${cohortJobs[i].key}: ${r.reason instanceof Error ? r.reason.message : r.reason}`
          : null,
      )
      .filter(Boolean) as string[];
    console.log(
      `[worker] cohort done in ${((Date.now() - cohortStart) / 1000).toFixed(1)}s (${okCount}/${cohortJobs.length} ok)${failures.length ? `: ${failures.join("; ")}` : ""}`,
    );

    if (process.env.AGGREGATE_OUTPUT_PATH && publishedBenches.length > 0) {
      // Augment hlBuilders (Prom cohort, active builders only) with every
      // slug from the hyperliquid-frontends spec. Since 2026-09-17 the
      // sitemap lists all of them as /products/<slug> (the one page per
      // product); the list is still passed so the builder can union it.
      const hlFrontendSpec = specs.find((s) => s.slug === "hyperliquid-frontends");
      const hlFrontendSpecSlugs = (hlFrontendSpec?.providers ?? []).map(
        (p: { slug: string }) => p.slug,
      );
      const allHlSlugs = [...new Set([...hlBuilders, ...hlFrontendSpecSlugs])];
      const slimResult = await publishSitemapSlim(publishedBenches, allHlSlugs);
      if (slimResult.ok) {
        console.log(`[worker] sitemap slim published (${slimResult.bytes} bytes)`);
      } else {
        console.warn(`[worker] sitemap slim failed: ${slimResult.error}`);
      }
    }
  }

  // Keep the bench pages warm on every cycle: ISR revalidate is 60s, so
  // a ping per sweep means the CDN always serves a fresh-enough copy
  // instantly to real visitors.
  await warmUrls(
    specs.map((s) => `/benchmarks/${s.slug}`),
    "pages",
  );

  if (iteration % VARIANT_EVERY === 0) {
    const tB0 = Date.now();
    const jobs: { spec: Spec; filters: BenchmarkFilters }[] = [];
    for (const spec of specs) {
      for (const filters of variantCombos(spec)) jobs.push({ spec, filters });
    }
    await inBatches(jobs, BENCH_CONCURRENCY, async ({ spec, filters }) => {
      try {
        await materializeOne(spec, filters);
      } catch (err) {
        console.warn(`[worker] tierB ${spec.slug}/${filterSig(filters)}: ${err instanceof Error ? err.message : err}`);
      }
    });
    console.log(`[worker] tierB done in ${((Date.now() - tB0) / 1000).toFixed(1)}s (${jobs.length} variants)`);

    // Broadcast per-variant blobs so the site's filter-tab reads
    // (/benchmarks/[slug]/[chain] etc.) go to the CDN edge instead of
    // fanning out through SRH. Mirrors the tier-A per-bench publish
    // in publishAggregate.
    if (process.env.AGGREGATE_OUTPUT_PATH) {
      const vpStart = Date.now();
      const result = await publishVariants(specs, variantCombos);
      const elapsedSec = ((Date.now() - vpStart) / 1000).toFixed(1);
      if (result.ok) {
        console.log(
          `[worker] variants published in ${elapsedSec}s (${result.count} files, ${result.bytes} bytes, ${result.errors ?? 0} errors)`,
        );
      } else {
        console.warn(
          `[worker] variants publish failed in ${elapsedSec}s: ${result.error}`,
        );
      }
    }

    await warmUrls(
      jobs.map(({ spec, filters }) => variantPath(spec.slug, filters)),
      "variants",
    );
  }
}

async function main() {
  if (!storeConfigured()) {
    console.error("[worker] KV_REST_API_URL/TOKEN missing, refusing to start");
    process.exit(1);
  }
  if (!process.env.PROMETHEUS_URL) {
    console.error("[worker] PROMETHEUS_URL missing, refusing to start");
    process.exit(1);
  }
  console.log(`[worker] starting: sweep every ${SWEEP_SEC}s, variants every ${VARIANT_EVERY} sweeps`);
  let iteration = 0;
  let running = false;
  const tick = async () => {
    if (running) {
      console.warn("[worker] previous sweep still running, skipping tick");
      return;
    }
    running = true;
    try {
      await sweep(iteration++);
    } catch (err) {
      console.error(`[worker] sweep failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      running = false;
    }
  };
  await tick();
  setInterval(tick, SWEEP_SEC * 1000);
}

main();
