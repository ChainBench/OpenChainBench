import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Two cache keys in spec.ts have to move together, and nothing made them.
 *
 * `bench-unfiltered-vN` caches one bench at a time; `all-benchmarks-vM` caches
 * the set. Thirty comment lines say so, every one of them in the form
 * "vM: lockstep with bench-unfiltered-vN", and the convention was carried by
 * hand for 84 bumps.
 *
 * What it costs to miss one: a cached entry holds the provider set that was
 * current when it was written. On 2026-10-21 Nova joined bench 030 and the
 * aggregate blob published 105 results with its row live at $5.28, while
 * /api/stat and the rendered page kept serving 104 and the row never
 * appeared. Seven minutes of polling and a full field-by-field diff of the
 * blob rows went into finding that, and the fix was a bump.
 *
 * Asserted against the source because the keys are literals inside
 * unstable_cache calls, which cannot be imported without pulling in Next's
 * cache runtime.
 */
const SRC = readFileSync(join(import.meta.dir, "spec.ts"), "utf8");

function version(prefix: string): number {
  const m = SRC.match(new RegExp(`\\["${prefix}-v(\\d+)"`));
  expect(m, `${prefix} key literal not found in spec.ts`).not.toBeNull();
  return Number(m![1]);
}

describe("the two bench cache keys move together", () => {
  test("each key appears exactly once as a literal", () => {
    for (const prefix of ["bench-unfiltered", "all-benchmarks"]) {
      const hits = SRC.match(new RegExp(`\\["${prefix}-v\\d+"`, "g")) ?? [];
      expect(hits.length, `${prefix} should be defined once, found ${hits.length}`).toBe(1);
    }
  });

  test("the newest comment on each names the other's current version", () => {
    const bench = version("bench-unfiltered");
    const all = version("all-benchmarks");
    // The lockstep note on the set key must point at the per-bench key's
    // live version. If someone bumps one alone, this is the line that is
    // left behind, and it is the cheapest possible signal.
    expect(
      SRC,
      `all-benchmarks is at v${all} and should carry a lockstep note naming bench-unfiltered-v${bench}`,
    ).toContain(`// v${all}: lockstep with bench-unfiltered-v${bench}`);
  });

  test("both keys are scoped by environment, so prod and preview never share one", () => {
    // A shared entry would let a preview deploy's provider set reach prod.
    const scoped =
      SRC.match(
        /\["(?:bench-unfiltered|all-benchmarks)-v\d+",\s*process\.env\.VERCEL_ENV === "production" \? "prod" : "all"\]/g,
      ) ?? [];
    expect(scoped.length).toBe(2);
  });
});

/**
 * There is a THIRD key, and this test did not know about it.
 *
 * `bench-filters-vK` caches a bench's dimension-filtered variants. It only
 * matters for a bench that declares `dimensions`, which is why it legitimately
 * lags the other two: it sat at v35 while bench-unfiltered went to v93,
 * because none of the benches Nova joined then had dimensions. Bench 295 does
 * (kind and bucket), so adding Nova there needed all three to move, and a
 * provider missing from this key is invisible on every tab.
 *
 * So the rule is conditional and cannot be checked statically. What can be
 * checked is that the key exists, is unique, is environment-scoped like the
 * others, and never runs ahead of the per-bench key it is pinned to, which is
 * the shape every mistake here would take.
 */
describe("the dimension-filtered cache key", () => {
  test("it is defined once and scoped by environment like the other two", () => {
    const hits = SRC.match(/\["bench-filters-v\d+"/g) ?? [];
    expect(hits.length, `bench-filters should be defined once, found ${hits.length}`).toBe(1);
    expect(SRC).toMatch(
      /\["bench-filters-v\d+",\s*process\.env\.VERCEL_ENV === "production" \? "prod" : "all"\]/,
    );
  });

  test("its newest note names a per-bench version that exists", () => {
    const filters = version("bench-filters");
    const bench = version("bench-unfiltered");
    const note = SRC.match(
      new RegExp(`// v${filters}: lockstep with bench-unfiltered-v(\\d+)`),
    );
    expect(
      note,
      `bench-filters is at v${filters} and should carry a note naming the bench-unfiltered version it was bumped with`,
    ).not.toBeNull();
    // Pinned to a future version means the note was written against a bump
    // that never happened.
    expect(Number(note![1])).toBeLessThanOrEqual(bench);
  });
});
