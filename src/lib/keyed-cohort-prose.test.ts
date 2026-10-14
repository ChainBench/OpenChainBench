import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

/**
 * The methodology bullet that enumerates the private cohort must name every
 * provider the page actually ranks in it.
 *
 * This has now rotted three times. Dwellir joined the keyed tier on all eight
 * EVM chains in September and was never added to the prose, so nine pages
 * described a five-provider cohort while ranking six. Robinhood's list kept a
 * different provider order and silently omitted two. A reader checking our
 * method against our table found a list that disagreed with it.
 *
 * Nothing derives this sentence from the data, which is why it drifts, so the
 * test reads the specs and compares the two directly: every keyed provider's
 * display name must appear somewhere in the bullet that introduces the cohort.
 * A provider added to a spec without a prose edit fails here rather than on
 * the page.
 */

const SPEC_DIR = join(import.meta.dir, "..", "..", "benchmarks");

type SpecProvider = { slug?: string; name?: string; tier?: string };
type Spec = { providers?: SpecProvider[]; methodology?: string[] };

/** The bullet that introduces the private cohort, for specs that have one. */
function cohortBullet(spec: Spec): string | null {
  return (spec.methodology ?? []).find((b) => b.includes("Private cohort")) ?? null;
}

function keyedSpecs(): { file: string; spec: Spec }[] {
  return readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith("-rpc.yml"))
    .map((file) => ({
      file,
      spec: yaml.load(readFileSync(join(SPEC_DIR, file), "utf8")) as Spec,
    }))
    .filter(({ spec }) => (spec.providers ?? []).some((p) => p?.tier === "keyed"));
}

describe("private cohort prose", () => {
  const specs = keyedSpecs();

  test("the keyed chain specs are found", () => {
    expect(specs.length).toBeGreaterThanOrEqual(9);
  });

  test("every spec with a keyed tier introduces the cohort in its methodology", () => {
    const silent = specs.filter(({ spec }) => !cohortBullet(spec)).map((s) => s.file);
    expect(silent).toEqual([]);
  });

  test("the bullet names every provider the keyed tier ranks", () => {
    const unnamed: string[] = [];
    for (const { file, spec } of specs) {
      const bullet = cohortBullet(spec);
      if (!bullet) continue;
      for (const p of spec.providers ?? []) {
        if (p?.tier !== "keyed" || !p.name) continue;
        if (!bullet.includes(p.name)) unnamed.push(`${file}: ${p.name}`);
      }
    }
    expect(unnamed).toEqual([]);
  });

  // The opposite direction, a name left in the prose after its row was
  // removed, is deliberately not checked. It cannot be read from this
  // sentence: several chains we bench are also provider names elsewhere in
  // the directory, and the bullet necessarily says "keyed Arc endpoints" or
  // "keyed Arbitrum endpoints". A first attempt flagged Arc, Arbitrum and
  // Robinhood as ghost vendors on their own pages. Omission is the failure
  // that has actually happened, three times; a stale extra name has not.

  // The grammar slip a previous substitution left behind on one page.
  test("no list reads \"and X and Y\"", () => {
    const broken: string[] = [];
    for (const { file } of specs) {
      const raw = readFileSync(join(SPEC_DIR, file), "utf8");
      if (/ and [A-Z][A-Za-z]+ and [A-Z]/.test(raw)) broken.push(file);
    }
    expect(broken).toEqual([]);
  });
});
