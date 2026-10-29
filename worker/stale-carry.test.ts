import { describe, expect, test } from "bun:test";
import { mergeWithPrevious } from "./merge";
import type { Benchmark } from "@/types/benchmark";
import type { MaterializedSnapshot } from "@/lib/materialize/schema";

/**
 * The carry-forward exists so a transient Prometheus failure does not blank a
 * row. Without a ceiling it also survives a catalogue correction, and then the
 * page goes on ranking something the harness has deliberately withdrawn.
 *
 * Bench 283 had three tabs in that state at once. OnFinality led the Solana
 * tab 22 hours after its withdrawal and dRPC sat second 115 hours after,
 * pushing the real leader to third. Ankr and InstaNodes held second and third
 * on the trace tab, for a workload their own plans refuse, under a
 * methodology that promises a refusal "shows as its absence from the trace
 * tab". Every carried row rendered availability "live" at a 100% success
 * rate, because the ledger never reads `meta`.
 */
const HOUR = 3600_000;

const result = (slug: string, p50: number) =>
  ({
    slug,
    name: slug,
    ms: { p50, p90: p50, p99: p50, mean: p50 },
    availability: "live",
    successRate: 100,
  }) as unknown as Benchmark["results"][number];

const bench = (slugs: [string, number][]): Benchmark =>
  ({
    slug: "rpc-free-tier",
    results: slugs.map(([s, v]) => result(s, v)),
    extras: { series24h: {}, regions: {} },
  }) as unknown as Benchmark;

function prevSnapshot(
  slugs: [string, number][],
  observedAgoMs: Record<string, number>,
  now: number,
): MaterializedSnapshot {
  return {
    bench: bench(slugs),
    builtAt: now - HOUR,
    state: {
      providers: Object.fromEntries(
        slugs.map(([s]) => [s, { observedAt: now - (observedAgoMs[s] ?? 0) }]),
      ),
      rings: {},
    },
  } as unknown as MaterializedSnapshot;
}

describe("carrying a provider the harness stopped publishing", () => {
  const now = Date.now();
  const declared = new Set(["syndica", "onfinality", "drpc"]);

  test("keeps a row through a short gap, which is what the carry is for", () => {
    const prev = prevSnapshot(
      [["syndica", 10_000_000], ["onfinality", 12_000_000]],
      { onfinality: 5 * 60_000 },
      now,
    );
    const { bench: out } = mergeWithPrevious(
      bench([["syndica", 10_000_000]]),
      prev,
      now,
      declared,
      3 * 3600, // expected_freshness_seconds on this bench
    );
    expect(out.results.map((r: { slug: string }) => r.slug).sort()).toEqual([
      "onfinality",
      "syndica",
    ]);
  });

  test("drops a row withdrawn longer ago than the bench's own freshness window", () => {
    // OnFinality 22h stale, dRPC 115h stale: both were ranked above the real
    // leader on the live board.
    const prev = prevSnapshot(
      [
        ["syndica", 10_000_000],
        ["onfinality", 12_000_000],
        ["drpc", 10_500_000],
      ],
      { onfinality: 22 * HOUR, drpc: 115 * HOUR },
      now,
    );
    const { bench: out } = mergeWithPrevious(
      bench([["syndica", 10_000_000]]),
      prev,
      now,
      declared,
      3 * 3600,
    );
    expect(out.results.map((r: { slug: string }) => r.slug)).toEqual(["syndica"]);
  });

  test("falls back to a finite ceiling when the spec declares no freshness", () => {
    const prev = prevSnapshot(
      [["syndica", 1], ["onfinality", 2]],
      { onfinality: 48 * HOUR },
      now,
    );
    const { bench: out } = mergeWithPrevious(
      bench([["syndica", 1]]),
      prev,
      now,
      declared,
      undefined,
    );
    expect(out.results.map((r: { slug: string }) => r.slug)).toEqual(["syndica"]);
  });

  test("still refuses to carry a provider dropped from the spec entirely", () => {
    // The pre-existing guard, kept: an editorial removal is not a gap.
    const prev = prevSnapshot([["syndica", 1], ["ghost", 9]], { ghost: 60_000 }, now);
    const { bench: out } = mergeWithPrevious(
      bench([["syndica", 1]]),
      prev,
      now,
      new Set(["syndica"]),
      3 * 3600,
    );
    expect(out.results.map((r: { slug: string }) => r.slug)).toEqual(["syndica"]);
  });
});

describe("carrying a panel value the harness stopped publishing", () => {
  const now = Date.now();
  const withPanel = (
    b: Benchmark,
    values: Record<string, number>,
    meta?: Record<string, { observedAt: number }>,
  ) =>
    ({
      ...b,
      metricPanels: [{ id: "per_million", values, valuesMeta: meta }],
    }) as unknown as Benchmark;

  // Bench 282 served Instanodes' per-million price hours after it left the
  // spec, and AWS AMB's Solana break-even 265 hours after the harness stopped
  // emitting it: the panel carry had neither guard the row carry has.
  test("drops a panel value for a provider no longer in the spec", () => {
    const prev = prevSnapshot([["dwellir", 1]], {}, now);
    prev.bench = withPanel(prev.bench, { dwellir: 2, instanodes: 7.9 }, {
      dwellir: { observedAt: now - HOUR },
      instanodes: { observedAt: now - HOUR },
    });
    const { bench: out } = mergeWithPrevious(
      withPanel(bench([["dwellir", 1]]), { dwellir: 2 }),
      prev,
      now,
      new Set(["dwellir"]),
      3 * 3600,
    );
    expect(Object.keys(out.metricPanels?.[0]?.values ?? {})).toEqual(["dwellir"]);
  });

  test("drops a panel value older than the carry ceiling, keeps a recent one", () => {
    const prev = prevSnapshot([["dwellir", 1]], {}, now);
    prev.bench = withPanel(prev.bench, { "aws-amb": 9.782, zeeve: 3 }, {
      "aws-amb": { observedAt: now - 265 * HOUR },
      zeeve: { observedAt: now - 10 * 60_000 },
    });
    const { bench: out } = mergeWithPrevious(
      withPanel(bench([["dwellir", 1]]), {}),
      prev,
      now,
      new Set(["dwellir", "aws-amb", "zeeve"]),
      3 * 3600,
    );
    expect(Object.keys(out.metricPanels?.[0]?.values ?? {})).toEqual(["zeeve"]);
  });
});

// A filtered view's empty load is an answer, not a failure.
//
// On 2026-10-22 the harness purged every EVM row, deleted their series and
// published health 0. The loader returned an empty board for the chain tabs,
// which it does on purpose. This carry put them all back, and the tabs served
// Axiom at 518.6 bps on Robinhood and Binance Wallet at 220.5 on Ethereum,
// marked live, for half an hour. Every future purge would repeat it.
test("a filtered view does not carry rows the load dropped", () => {
  const prev = {
    v: 1,
    slug: "b",
    sig: "chain=robinhood",
    builtAt: Date.now() - 60_000,
    bench: {
      slug: "b",
      status: "live",
      results: [
        { slug: "axiom", name: "Axiom", ms: { p50: 518.6 } },
        { slug: "gmgn", name: "GMGN", ms: { p50: 420.4 } },
      ],
      extras: {},
    },
    state: { providers: {}, rings: {} },
  } as never;
  const fresh = { slug: "b", status: "live", results: [], extras: {} } as never;

  // authoritative: the chain tab answered, and its answer is "nothing".
  const { bench: filtered } = mergeWithPrevious(
    fresh,
    prev,
    Date.now(),
    new Set(["axiom", "gmgn"]),
    900,
    true,
  );
  expect(filtered.results).toHaveLength(0);

  // The unfiltered board still carries, because there a total blank is more
  // likely a brownout than a state.
  const { bench: board } = mergeWithPrevious(
    fresh,
    prev,
    Date.now(),
    new Set(["axiom", "gmgn"]),
    900,
    false,
  );
  expect(board.results).toHaveLength(2);
});

/**
 * The per-chain and per-cell stashes carry on their own clock.
 *
 * Each is produced by a separate Prom query that load.ts lets fail, leaving
 * the field undefined. Nothing carried them on the blob the site reads, so one
 * failed matrix query took a chain-scoped badge's figure and the /badges
 * picker that asks for it off eight benches for a cycle. Two of those publish
 * two cells, so "the query degraded" and "the query failed" look the same.
 *
 * The ceiling is why the observation time is stored. `builtAt` is restamped on
 * every sweep, so a carried stash dated from it would be re-dated fresh each
 * pass and live forever: the "unbounded carry" in this file's subject, in the
 * function it warns about. The repeated-sweep test below is the one that
 * separates a bounded carry from that, and a carry that merely "looks right"
 * passes every other test here.
 */
describe("carrying a per-cell stash through a failed matrix query", () => {
  const now = Date.now();
  const CELLS = { "base|all": [{ slug: "drpc", p50: 91 }] };
  const BEST = { base: result("drpc", 91) };

  type Stash = Partial<
    Pick<
      Benchmark,
      "cellRanks" | "bestPerChain" | "worstPerChain" | "providersPerChain"
    >
  >;

  const withStash = (b: Benchmark, s: Stash): Benchmark =>
    ({ ...b, ...s }) as unknown as Benchmark;

  function prevWithStash(
    s: Stash,
    stashes: Record<string, { observedAt: number; staleSince?: number }> | undefined,
    builtAt: number,
  ): MaterializedSnapshot {
    return {
      bench: withStash(bench([["drpc", 91]]), s),
      builtAt,
      state: { providers: {}, rings: {}, stashes },
      sweepMs: 60_000,
    } as unknown as MaterializedSnapshot;
  }

  test("keeps the cells when this sweep's matrix query produced none", () => {
    const prev = prevWithStash({ cellRanks: CELLS }, { cellRanks: { observedAt: now - 5 * 60_000 } }, now - 60_000);
    const { bench: out, state } = mergeWithPrevious(
      bench([["drpc", 91]]),
      prev,
      now,
      new Set(["drpc"]),
      3 * 3600,
    );
    expect(out.cellRanks).toEqual(CELLS);
    // The carry keeps the original observation and records when it went stale,
    // which is what the next sweep measures the ceiling against.
    expect(state.stashes?.cellRanks.observedAt).toBe(now - 5 * 60_000);
    expect(state.stashes?.cellRanks.staleSince).toBe(now);
  });

  test("drops cells older than the bench's own freshness window", () => {
    const prev = prevWithStash({ cellRanks: CELLS }, { cellRanks: { observedAt: now - 4 * HOUR } }, now - 60_000);
    const { bench: out, state } = mergeWithPrevious(
      bench([["drpc", 91]]),
      prev,
      now,
      new Set(["drpc"]),
      3 * 3600, // expected_freshness_seconds: 3 h, and the stash is 4 h old
    );
    expect(out.cellRanks).toBeUndefined();
    expect(state.stashes?.cellRanks).toBeUndefined();
  });

  test("a stash carried across sweeps expires instead of being re-dated", () => {
    // The whole point of storing the time. Three sweeps, one minute apart on
    // the clock the worker actually runs at, with the previous sweep's own
    // state fed back in: a carry dated from builtAt reads as fresh forever
    // here, because builtAt moves with every sweep.
    const t0 = now - 4 * HOUR;
    let prev = prevWithStash({ cellRanks: CELLS }, { cellRanks: { observedAt: t0 } }, t0);
    let sweeps = 0;
    for (let t = t0 + 60_000; t <= t0 + 3 * HOUR; t += 60_000) {
      const { bench: out, state } = mergeWithPrevious(
        bench([["drpc", 91]]),
        prev,
        t,
        new Set(["drpc"]),
        3 * 3600,
      );
      expect(state.stashes?.cellRanks.observedAt).toBe(t0);
      prev = {
        bench: out,
        builtAt: t,
        state,
        sweepMs: 60_000,
      } as unknown as MaterializedSnapshot;
      sweeps++;
    }
    expect(sweeps).toBeGreaterThan(100);
    // One more minute puts it past the three-hour window, and it goes.
    const { bench: expired } = mergeWithPrevious(
      bench([["drpc", 91]]),
      prev,
      t0 + 3 * HOUR + 2 * 60_000,
      new Set(["drpc"]),
      3 * 3600,
    );
    expect(expired.cellRanks).toBeUndefined();
  });

  test("a fresh stash wins and is dated now, never carried", () => {
    const fresher = { "solana|all": [{ slug: "helius", p50: 44 }] };
    const prev = prevWithStash({ cellRanks: CELLS }, { cellRanks: { observedAt: now - 5 * 60_000 } }, now - 60_000);
    const { bench: out, state } = mergeWithPrevious(
      withStash(bench([["drpc", 91]]), { cellRanks: fresher }),
      prev,
      now,
      new Set(["drpc"]),
      3 * 3600,
    );
    expect(out.cellRanks).toEqual(fresher);
    expect(state.stashes?.cellRanks.observedAt).toBe(now);
    expect(state.stashes?.cellRanks.staleSince).toBeUndefined();
  });

  test("an empty stash is a failure, not an answer", () => {
    // tryLoadCellRanks returning {} must not displace a populated carry and
    // then be stamped fresh: that is how a blank outlives the gap that made
    // it, with a timestamp saying it was just measured.
    const prev = prevWithStash({ cellRanks: CELLS }, { cellRanks: { observedAt: now - 5 * 60_000 } }, now - 60_000);
    const { bench: out, state } = mergeWithPrevious(
      withStash(bench([["drpc", 91]]), { cellRanks: {} }),
      prev,
      now,
      new Set(["drpc"]),
      3 * 3600,
    );
    expect(out.cellRanks).toEqual(CELLS);
    expect(state.stashes?.cellRanks.observedAt).toBe(now - 5 * 60_000);
  });

  test("carries the per-chain stashes on the same rule", () => {
    // worstPerChain and providersPerChain share bestPerChain's key set and
    // population conditions, so they fail together and carry together.
    const prev = prevWithStash(
      {
        bestPerChain: BEST,
        worstPerChain: BEST,
        providersPerChain: { base: ["drpc"] },
      },
      {
        bestPerChain: { observedAt: now - 60_000 },
        worstPerChain: { observedAt: now - 60_000 },
        providersPerChain: { observedAt: now - 4 * HOUR },
      },
      now - 60_000,
    );
    const { bench: out } = mergeWithPrevious(
      bench([["drpc", 91]]),
      prev,
      now,
      new Set(["drpc"]),
      3 * 3600,
    );
    expect(out.bestPerChain).toEqual(BEST);
    expect(out.worstPerChain).toEqual(BEST);
    // Past the ceiling on its own clock, independent of the other two.
    expect(out.providersPerChain).toBeUndefined();
  });

  test("a filtered view carries no stash", () => {
    // load.ts computes cellRanks only on the unfiltered load, so a stash on a
    // filtered view could only have come from somewhere it does not describe.
    const prev = prevWithStash({ cellRanks: CELLS }, { cellRanks: { observedAt: now - 60_000 } }, now - 60_000);
    const { bench: out } = mergeWithPrevious(
      bench([["drpc", 91]]),
      prev,
      now,
      new Set(["drpc"]),
      3 * 3600,
      true,
    );
    expect(out.cellRanks).toBeUndefined();
  });

  test("a first sweep after deploy dates the carry from the previous blob", () => {
    // Blobs written before state.stashes existed carry no time. Falling back
    // to that blob's builtAt dates it once, conservatively, and the next sweep
    // stores the real time, so this cannot become the unbounded path.
    const prev = prevWithStash({ cellRanks: CELLS }, undefined, now - 90 * 60_000);
    const { bench: out, state } = mergeWithPrevious(
      bench([["drpc", 91]]),
      prev,
      now,
      new Set(["drpc"]),
      3 * 3600,
    );
    expect(out.cellRanks).toEqual(CELLS);
    expect(state.stashes?.cellRanks.observedAt).toBe(now - 90 * 60_000);

    // And a legacy blob already past the ceiling is dropped, not adopted.
    const old = prevWithStash({ cellRanks: CELLS }, undefined, now - 4 * HOUR);
    const { bench: dropped } = mergeWithPrevious(
      bench([["drpc", 91]]),
      old,
      now,
      new Set(["drpc"]),
      3 * 3600,
    );
    expect(dropped.cellRanks).toBeUndefined();
  });
});
