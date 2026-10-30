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

/** The per-chain and per-cell stashes, each computed by its own Prom query
 *  and each carried on its own observation time. `worstPerChain` and
 *  `providersPerChain` share `bestPerChain`'s key set and population
 *  conditions, so they fail together and are carried together. */
const STASH_KEYS = [
  "cellRanks",
  "bestPerChain",
  "worstPerChain",
  "providersPerChain",
] as const;
type StashKey = (typeof STASH_KEYS)[number];

/** A stash that loaded but found nothing is treated as absent, so an empty
 *  result cannot overwrite a populated carry and then be stamped fresh. */
function hasEntries(v: unknown): boolean {
  return (
    typeof v === "object" && v !== null && Object.keys(v as object).length > 0
  );
}

export function mergeWithPrevious(
  fresh: Benchmark,
  prev: MaterializedSnapshot | null,
  now: number,
  declaredSlugs?: Set<string>,
  maxCarrySec?: number,
  // authoritative: this load's result is the answer, so nothing is carried.
  // Set on a filtered view, where load.ts returns an empty board on purpose
  // when every provider fell under the floor. Carrying there re-published
  // figures the harness had just purged, marked live, for half an hour
  // (2026-10-22: Axiom 518.6 bps on Robinhood, Binance Wallet 220.5 on
  // Ethereum). A total collapse returns before the merge is reached, so an
  // empty result here is a state and not a failure.
  authoritative?: boolean,
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
  if (prevBench && !authoritative) {
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

    // Per-chain and per-cell stashes: carried like a row, for the same
    // reason and under the same ceiling.
    //
    // Each comes from its own Prom query (load.ts: `tryLoadCellRanks`, the
    // bestForChain pass) which can fail on an otherwise-healthy cycle, and
    // load.ts tolerates that by leaving the field undefined. Nothing then
    // carried it: `writeSnapshot` in src/lib/snapshot.ts does, naming
    // scoped badges as the reason, but nothing imports that module, so the
    // carry only ever existed on the KV path and the site reads this blob.
    //
    // What that costs is visible rather than theoretical. A badge scoped to
    // a chain is served from `cellRanks` and withholds the rank without it
    // (src/lib/badge-scope.ts), and /badges offers its Chain picker only
    // where `cellRanks` says the badge can answer. So one failed matrix
    // query took the scoped figure AND the control that asks for it off
    // eight benches for a cycle, two of which publish two cells.
    //
    // The ceiling is the one the rows get, which is the bench's own
    // `expected_freshness_seconds` where it declares one: a ranking carried
    // past the window the bench claims its data is good for is its own lie.
    // It is measured against `state.stashes`, not `builtAt`, because
    // `builtAt` is restamped every sweep and a stash dated from it would
    // never expire. That is the unbounded carry this file's header is about.
    for (const key of STASH_KEYS) {
      if (hasEntries(fresh[key])) {
        (state.stashes ??= {})[key] = { observedAt: now };
        continue;
      }
      const prevStash = prevBench[key];
      if (!hasEntries(prevStash)) continue;
      const pm = prevState?.stashes?.[key];
      // No recorded time means a blob from before this field: date it from
      // that blob once, then the line above records the real time.
      const observedAt = pm?.observedAt ?? prev?.builtAt ?? now;
      if (now - observedAt > carryMs) continue;
      // The four stashes hold four different value shapes, and the write
      // is the one place the key's union has to be erased.
      (fresh as Record<StashKey, unknown>)[key] = prevStash;
      (state.stashes ??= {})[key] = {
        observedAt,
        staleSince: pm?.staleSince ?? now,
      };
    }

    // Panels: carry per-provider values the same way, and under the same
    // rule: a filtered view that answered does not carry.
    for (const panel of fresh.metricPanels ?? []) {
      const prevPanel = (prevBench.metricPanels ?? []).find(
        (p: MetricPanel) => p.id === panel.id,
      );
      if (!prevPanel) continue;
      // A panel can declare that a missing value is a STATEMENT, not a gap.
      // The carry exists for a query that failed, and a query that filters
      // deliberately is indistinguishable from one that failed when seen
      // from here. Bench 311's eth_call work term drops a non-positive
      // difference, because the heavy leg cannot be the faster one, and the
      // carry put minus 1.84 ms back on the board for the length of the
      // ceiling, where a lower-is-better view ranks it first.
      if (panel.carry === false) continue;
      panel.valuesMeta ??= {};
      for (const slug of Object.keys(panel.values)) {
        panel.valuesMeta[slug] = { observedAt: now };
      }
      for (const [slug, v] of Object.entries(prevPanel.values)) {
        if (panel.values[slug] != null) continue;
        // The same two guards as the result carry above. Without them a
        // panel value outlived its provider: bench 282 kept serving
        // Instanodes' per-million price hours after it left the spec, and a
        // Solana break-even for two Ethereum-only nodes 265 h after the
        // harness stopped emitting it (audit 2026-10-16).
        if (declaredSlugs && !declaredSlugs.has(slug)) continue;
        const pm = prevPanel.valuesMeta?.[slug];
        const observedAt = pm?.observedAt ?? prev?.builtAt ?? now;
        if (now - observedAt > carryMs) continue;
        panel.values[slug] = v;
        panel.valuesMeta[slug] = {
          observedAt,
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
