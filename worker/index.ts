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
} from "@/lib/materialize/store";
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
  const opt = <T,>(xs: T[]): (T | undefined)[] => (xs.length ? [undefined, ...xs] : [undefined]);
  const combos: BenchmarkFilters[] = [];
  for (const chain of opt(chains)) {
    for (const region of opt(regions)) {
      for (const kind of opt(kinds)) {
        if (!chain && !region && !kind) continue; // the aggregate is tier A
        combos.push({
          ...(chain ? { chain } : {}),
          ...(region ? { region } : {}),
          ...(kind ? { kind } : {}),
        });
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

async function sweep(iteration: number): Promise<void> {
  const specs = await loadSpecsUncached();
  const t0 = Date.now();

  await inBatches(specs, BENCH_CONCURRENCY, async (spec) => {
    try {
      await materializeOne(spec, {});
    } catch (err) {
      console.warn(`[worker] tierA ${spec.slug}: ${err instanceof Error ? err.message : err}`);
    }
  });
  console.log(`[worker] tierA done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${specs.length} benches)`);
  await heartbeat().catch((e) => console.warn(`[worker] heartbeat: ${e.message}`));

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
