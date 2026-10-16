import { describe, expect, test } from "bun:test";
import { computeFieldStats } from "@/lib/stats";
import type { ProviderResult } from "@/types/benchmark";

/**
 * `zero_is_a_value` says a zero CAN be an answer. It does not say every zero
 * is one, and reading it that way put "Best $0" at the top of bench 282's
 * default view.
 *
 * Blockdaemon publishes no paid price — all three of its paid plans are
 * confidence: unpublished — so it carries no headline result. The load path
 * promoted it to "live" anyway on the strength of its companion panels, and
 * with the all-zero guard switched off by `zero_is_a_value` the strip read
 * Best "$0" above a ledger whose real leader is BlockPI at $29.50. The
 * spread printed "-" too, because tailMin had become 0.
 *
 * The ledger never showed that row: it drops at the 5% success floor. The
 * two halves of one page disagreed, and the half a reader trusts was wrong.
 */
const row = (
  slug: string,
  p50: number,
  availability: "live" | "unavailable",
  successRate: number,
): ProviderResult =>
  ({
    slug,
    name: slug,
    ms: { p50, p90: p50, p99: p50, mean: p50 },
    availability,
    successRate,
  }) as unknown as ProviderResult;

describe("the summary strip under zero_is_a_value", () => {
  // The real board: one provider with no price at all, two with one.
  const board = [
    row("blockdaemon", 0, "live", 0),
    row("blockpi", 29.5, "live", 100),
    row("tatum", 287, "live", 100),
  ];

  test("does not crown a provider that was never measured", () => {
    const s = computeFieldStats(board, true);
    expect(s.fieldMin).toBe(29.5);
  });

  test("keeps the spread, which an unmeasured zero destroys", () => {
    const s = computeFieldStats(board, true);
    expect(s.tailMin).toBeGreaterThan(0);
    expect(s.tailSpread).toBeGreaterThan(1);
  });

  test("still keeps a measured zero, which is the whole point of the flag", () => {
    // Validation Cloud's Scale: no subscription, first 50M CU free. A real
    // price of nothing, with a real reading behind it.
    const withFree = [...board, row("validation-cloud", 0, "live", 100)];
    expect(computeFieldStats(withFree, true).fieldMin).toBe(0);
  });

  test("without the flag, an all-zero row is dropped as before", () => {
    expect(computeFieldStats(board, false).fieldMin).toBe(29.5);
  });

  test("an unavailable row never counts, flag or not", () => {
    const withUnavail = [...board, row("helius", 0, "unavailable", 0)];
    expect(computeFieldStats(withUnavail, true).fieldMin).toBe(29.5);
  });
});
