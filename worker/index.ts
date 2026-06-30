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
  filterSig,
  type BenchmarkFilters,
} from "@/lib/materialize/load";
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
import { fetchPerpCohortFresh } from "@/lib/perp-stats";
import {
  fetchHlCohortFresh,
  fetchHlHip3CohortFresh,
} from "@/lib/hl-builder-stats";
import { buildFeaturedLeadersFromStore } from "@/lib/search-featured";
import type { Benchmark, MetricPanel } from "@/types/benchmark";
import type { Spec } from "@/lib/spec-schema";

const SWEEP_SEC = Number(process.env.SWEEP_SEC ?? 60);
const VARIANT_EVERY = Number(process.env.VARIANT_EVERY ?? 5);
/** Benches materialized concurrently. The Prom client's own 64-slot
 *  query semaphore is global, so this only bounds per-bench overhead. */
const BENCH_CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 3);

function ringFromSeries(
  window: keyof typeof RING_CADENCE,
  series: number[],
  now: number,
): SeriesRing {
  const { stepSec } = RING_CADENCE[window];
  return {
    startEpoch: now - series.length * stepSec * 1000,
    stepSec,
    points: series,
  };
}

/** Merge a fresh live load with the previous snapshot: carried-forward
 *  providers keep last good values/series, marked via meta. */
function mergeWithPrevious(
  fresh: Benchmark,
  prev: MaterializedSnapshot | null,
  now: number,
): { bench: Benchmark; state: WorkerState } {
  const state: WorkerState = { providers: {}, rings: {} };
  const prevState = prev?.state;
  const prevBench = prev?.bench;

  const liveSlugs = new Set(fresh.results.map((r) => r.slug));

  // Fresh providers: stamp meta, refresh ring state from live series.
  for (const r of fresh.results) {
    r.meta = { observedAt: now };
    state.providers[r.slug] = r.meta;
    const rings: Record<string, SeriesRing> = {};
    const windows = [
      ["24h", fresh.extras.series24h?.[r.slug]],
      ["7d", fresh.extras.series7d?.[r.slug]],
      ["30d", fresh.extras.series30d?.[r.slug]],
    ] as const;
    for (const [w, s] of windows) {
      if (s && s.length > 0) rings[w] = ringFromSeries(w, s, now);
    }
    if (Object.keys(rings).length > 0) state.rings[r.slug] = rings;
  }

  // Carried providers: present in the previous snapshot, absent from this
  // sweep's live load. Keep values + series, set staleSince once.
  if (prevBench) {
    for (const pr of prevBench.results) {
      if (liveSlugs.has(pr.slug)) continue;
      const prevMeta: StalenessMeta = prevState?.providers[pr.slug] ?? {
        observedAt: prev?.builtAt ?? now,
      };
      const meta: StalenessMeta = {
        observedAt: prevMeta.observedAt,
        staleSince: prevMeta.staleSince ?? now,
      };
      fresh.results.push({ ...pr, meta });
      state.providers[pr.slug] = meta;
      const prevRings = prevState?.rings[pr.slug];
      if (prevRings) {
        state.rings[pr.slug] = prevRings;
        const s24 = prevRings["24h"]?.points;
        const s7 = prevRings["7d"]?.points;
        const s30 = prevRings["30d"]?.points;
        if (s24) (fresh.extras.series24h ??= {})[pr.slug] = s24 as number[];
        if (s7) (fresh.extras.series7d ??= {})[pr.slug] = s7 as number[];
        if (s30) (fresh.extras.series30d ??= {})[pr.slug] = s30 as number[];
      }
    }

    // Panels: carry per-provider values the same way.
    for (const panel of fresh.metricPanels ?? []) {
      const prevPanel = (prevBench.metricPanels ?? []).find(
        (p: MetricPanel) => p.id === panel.id,
      );
      if (!prevPanel) continue;
      panel.valuesMeta ??= {};
      for (const slug of Object.keys(panel.values)) {
        panel.valuesMeta[slug] = { observedAt: now };
      }
      for (const [slug, v] of Object.entries(prevPanel.values)) {
        if (panel.values[slug] != null) continue;
        const pm = prevPanel.valuesMeta?.[slug];
        panel.values[slug] = v;
        panel.valuesMeta[slug] = {
          observedAt: pm?.observedAt ?? prev?.builtAt ?? now,
          staleSince: pm?.staleSince ?? now,
        };
        if (prevPanel.seriesByProvider?.[slug] && panel.seriesByProvider) {
          panel.seriesByProvider[slug] ??= prevPanel.seriesByProvider[slug];
        }
      }
    }
  }

  fresh.dataAsOf = now;
  return { bench: fresh, state };
}

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
  const { bench, state } = mergeWithPrevious(fresh, prev, now);

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

function variantCombos(spec: Spec): BenchmarkFilters[] {
  const dims = spec.dimensions ?? {};
  const chains = (dims.chain ?? []).map((d) => d.value).filter((v) => v !== "all");
  const regions = (dims.region ?? []).map((d) => d.value).filter((v) => v !== "all");
  const kinds = (dims.kind ?? []).map((d) => d.value).filter((v) => v !== "all");
  const venues = (dims.venue ?? []).map((d) => d.value).filter((v) => v !== "all");
  const opt = <T,>(xs: T[]): (T | undefined)[] => (xs.length ? [undefined, ...xs] : [undefined]);
  const combos: BenchmarkFilters[] = [];
  for (const chain of opt(chains)) {
    for (const region of opt(regions)) {
      for (const kind of opt(kinds)) {
        for (const venue of opt(venues)) {
          if (!chain && !region && !kind && !venue) continue; // the aggregate is tier A
          combos.push({
            ...(chain ? { chain } : {}),
            ...(region ? { region } : {}),
            ...(kind ? { kind } : {}),
            ...(venue ? { venue } : {}),
          });
        }
      }
    }
  }
  return combos;
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

  // Cohort snapshots used by the hub pages and the search dialog. Each
  // builder hits Prom directly (via the in-network http://ocb-prom:9090
  // URL), so they don't add load on the public reverse proxy. Failures
  // are isolated per blob — a bad perp fetch doesn't block the HL or
  // featured-leaders writes.
  if (cohortSnapshotConfigured()) {
    const cohortStart = Date.now();
    const cohortJobs: Array<{
      key: string;
      build: () => Promise<unknown>;
    }> = [
      { key: "perp-cohort", build: () => fetchPerpCohortFresh() },
      { key: "hl-frontends", build: () => fetchHlCohortFresh() },
      { key: "hl-hip3", build: () => fetchHlHip3CohortFresh() },
      { key: "search-featured", build: () => buildFeaturedLeadersFromStore() },
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
