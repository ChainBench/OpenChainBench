import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

/**
 * Bench 144 divides market count by TVL, so a small vault inflates the ratio.
 *
 * It had no floor. A venue with one market and $120k of backing reads 8.4 and
 * ranks fourth of thirteen, above four venues carrying 66 to 334 markets,
 * while the bench's own methodology says a high number means the venue "can
 * list many markets cheaply". One market is the opposite of many.
 *
 * The floor is $1M, picked from a gap in the data rather than as a round
 * number: on 2026-10-22 the smallest ranked vault was Ostium at $3.95M and
 * the candidate was at $0.12M, 33 times below it. So the floor excludes
 * nobody in the field, changes no published figure, and is self-healing,
 * because it reads live TVL rather than naming a venue.
 */
const SPEC = join(import.meta.dir, "..", "..", "benchmarks", "perp-capital-efficiency.yml");

type Spec = {
  methodology?: string[];
  providers?: { slug: string; queries?: Record<string, string> }[];
};

const spec = yaml.load(readFileSync(SPEC, "utf8")) as Spec;
const FLOOR = 1000000;

describe("bench 144 will not rank a vault too small to mean anything", () => {
  test("every provider carries the TVL gate, on its own slug", () => {
    const providers = spec.providers ?? [];
    expect(providers.length).toBeGreaterThan(0);
    for (const p of providers) {
      const gate = p.queries?.ranked;
      expect(gate, `${p.slug} has no ranked gate`).toBeDefined();
      // Reading another venue's TVL would gate the wrong row, and a
      // copy-paste across thirteen blocks is exactly how that happens.
      expect(gate, `${p.slug}'s gate reads the wrong venue`).toContain(
        `venue="${p.slug}"`,
      );
      expect(gate).toContain(`>= bool ${FLOOR}`);
    }
  });

  test("the gate reads the same TVL series the ratio divides by", () => {
    // A floor on a different metric than the denominator would let a venue
    // pass on one number and be ranked on another.
    for (const p of spec.providers ?? []) {
      expect(p.queries?.ranked).toContain("perp_venue_tvl_usd");
      expect(p.queries?.p50).toContain("perp_venue_tvl_usd");
      expect(p.queries?.ranked).toContain("avg_over_time");
      expect(p.queries?.p50).toContain("avg_over_time");
    }
  });

  test("the floor is disclosed, with its value", () => {
    // An unstated threshold is an unexplained missing row.
    const floor = (spec.methodology ?? []).find((b) => b.startsWith("Floor."));
    expect(floor, "no Floor bullet in the methodology").toBeDefined();
    expect(floor).toContain("$1M");
    // And it says why, not just what.
    expect(floor).toMatch(/inflates|divides by TVL/);
  });
});
