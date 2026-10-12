import type { Benchmark, MetricPanel } from "@/types/benchmark";
import {
  RING_CADENCE,
  type MaterializedSnapshot,
  type SeriesRing,
  type StalenessMeta,
  type WorkerState,
} from "@/lib/materialize/schema";

/**
 * Snapshot merge, split out of worker/index.ts so it can be tested.
 *
 * index.ts refuses to load without KV credentials, by design: a worker with
 * nowhere to publish should not boot. That also made this merge unreachable
 * from a test, which is how an unbounded carry-forward shipped.
 */

function ringFromSeries(
  window: keyof typeof RING_CADENCE,
  series: (number | null)[],
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
/** How long a provider may be carried after the harness stops publishing it.
 *
 *  The carry exists for transient query failures. With no ceiling it also
 *  survives a catalogue correction, and the page then goes on ranking a row
 *  the harness deliberately withdrew — as availability "live" at a 100%
 *  success rate, because the ledger never reads `meta`.
 *
 *  Bench 283 had three tabs in that state at once. OnFinality led the Solana
 *  tab 22 hours after its withdrawal and dRPC sat second 115 hours after,
 *  pushing the real leader to third. Ankr and InstaNodes held second and
 *  third on the trace tab for a workload their own plans refuse, under a
 *  methodology promising a refusal "shows as its absence from the trace tab".
 *
 *  A bench's own `expected_freshness_seconds` is the right ceiling: it is the
 *  window the bench already claims its data is good for. The fallback is a
 *  day — generous, but finite, which "never" was not. */
const DEFAULT_MAX_CARRY_SEC = 24 * 60 * 60;

export function mergeWithPrevious(
  fresh: Benchmark,
  prev: MaterializedSnapshot | null,
  now: number,
  declaredSlugs?: Set<string>,
  maxCarrySec?: number,
): { bench: Benchmark; state: WorkerState } {
  const carryMs = (maxCarrySec ?? DEFAULT_MAX_CARRY_SEC) * 1000;
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
      // Deliberately delisted providers (removed from the spec) must NOT
      // be carried: the staleness carry exists for transient query
      // failures, not for editorial removals (1RPC ghost row, 2026-07-09).
      if (declaredSlugs && !declaredSlugs.has(pr.slug)) continue;
      const prevMeta: StalenessMeta = prevState?.providers[pr.slug] ?? {
        observedAt: prev?.builtAt ?? now,
      };
      // Past the ceiling this is no longer a transient gap, it is a
      // withdrawal. Dropping the row is what makes the harness's decision
      // visible on the page.
      if (now - prevMeta.observedAt > carryMs) continue;
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
