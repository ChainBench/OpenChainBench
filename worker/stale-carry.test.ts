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
