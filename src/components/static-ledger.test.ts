import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The static ledger is the Suspense fallback: it is what a crawler and a
 * no-JS reader get, and for them it is the only table on the page.
 *
 * It had drifted from the interactive one in two ways that both published
 * something the bench does not claim. Bench 282 sends no RPC traffic and sets
 * `ledger_reliability: false` — its own spec comment says a success rate
 * there "measures nothing" — yet this table printed a Success column filled
 * with 100.00%, the value the loader defaults to when a spec declares no
 * success query. And it headed the money column "Value" where every reader
 * of the real table sees "Monthly bill", because it took the generic label
 * instead of the one the spec names.
 *
 * Asserted against the source rather than a render: the component needs a
 * whole Benchmark and a React tree, and what is worth pinning here is that
 * the two values come from the spec at all.
 */
const SRC = readFileSync(
  join(import.meta.dir, "static-ledger.tsx"),
  "utf8",
);

describe("the crawler-facing ledger", () => {
  test("gates the Success column on the spec's own reliability flag", () => {
    expect(SRC).toContain("benchmark.ledgerReliability !== false");
    // Both the header cell and the body cell, or the table misaligns.
    const gated = SRC.match(/showReliability && \(/g) ?? [];
    expect(gated.length).toBe(2);
  });

  test("takes the value column's name from the spec when it names one", () => {
    expect(SRC).toContain('ledgerColumns?.find((c) => c.slot === "p50")?.label');
  });

  test("still falls back to the generic label for specs that name none", () => {
    expect(SRC).toContain("valueColumnLabel(benchmark)");
  });
});
