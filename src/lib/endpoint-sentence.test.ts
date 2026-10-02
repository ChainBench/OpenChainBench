import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * The endpoint sentence in the FAQ names a list of endpoints and states a
 * count. Those two drifted apart: the count was {{count}}, the display
 * cohort behind a 5 % success floor, while the names were authored and held
 * every declared endpoint. On 2026-10-02 twenty-nine specs disagreed with
 * themselves, the worst reading "2 endpoints sustain continuous keyless
 * probing today" above three names, one of which answered 1.4 % of the time.
 *
 * Both numbers are derived now, so the only thing that can rot is the claim
 * itself. These tests pin the claim.
 */
const DIR = path.join(process.cwd(), "benchmarks");
const specs = readdirSync(DIR)
  .filter((f) => f.endsWith(".yml"))
  .map((f) => ({ file: f, text: readFileSync(path.join(DIR, f), "utf8") }));

describe("the endpoint sentence", () => {
  test("there are specs to check, so the glob still resolves", () => {
    expect(specs.length).toBeGreaterThan(200);
  });

  // "sustain continuous keyless probing" asserts that every named endpoint
  // answers. It is the claim the measurement contradicted, so no spec may
  // make it again: an endpoint is probed whether or not it replies, and the
  // page now reports the ones that do not.
  test("no spec claims its endpoints sustain continuous probing", () => {
    const offenders = specs
      .filter((s) => s.text.includes("sustain continuous keyless probing"))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  // {{count}} is the display cohort. Pairing it with an authored list of
  // names is what produced the mismatch, so the sentence uses the derived
  // declared count instead.
  test("the endpoint sentence counts declared endpoints, not displayed ones", () => {
    const offenders = specs
      .filter((s) => /\{\{count\}\}[^"\n]{0,40}endpoints are probed on this chain/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  test("every spec using the sentence uses the derived placeholder", () => {
    const using = specs.filter((s) => s.text.includes("endpoints are probed on this chain"));
    expect(using.length).toBeGreaterThan(80);
    for (const s of using) {
      expect(s.text).toContain("{{declared_count}}");
    }
  });
});
