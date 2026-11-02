import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import {
  METHODOLOGY_LEAD_BULLETS,
  METHODOLOGY_SPLIT_WORDS,
  splitMethodology,
} from "@/lib/methodology-split";

const words = (n: number) => Array.from({ length: n }, () => "mot").join(" ");

describe("splitMethodology", () => {
  test("leaves a short methodology whole", () => {
    const bullets = [words(50), words(50), words(50), words(50)];
    const { lead, notes } = splitMethodology(bullets);
    expect(lead.length).toBe(4);
    expect(notes.length).toBe(0);
  });

  test("splits a long one after the lead bullets", () => {
    const bullets = Array.from({ length: 10 }, () => words(100));
    const { lead, notes } = splitMethodology(bullets);
    expect(lead.length).toBe(METHODOLOGY_LEAD_BULLETS);
    expect(notes.length).toBe(10 - METHODOLOGY_LEAD_BULLETS);
    // Nothing is dropped: the split moves bullets, it does not shorten.
    expect([...lead, ...notes]).toEqual(bullets);
  });

  test("never splits a methodology with no more bullets than the lead", () => {
    // Three very long bullets would otherwise produce an empty notes block
    // with a heading promising more.
    const bullets = [words(400), words(400), words(400)];
    const { lead, notes } = splitMethodology(bullets);
    expect(lead.length).toBe(3);
    expect(notes.length).toBe(0);
  });

  test("handles no methodology at all", () => {
    expect(splitMethodology(undefined)).toEqual({ lead: [], notes: [] });
    expect(splitMethodology([])).toEqual({ lead: [], notes: [] });
  });

  test("counts words, not bullets", () => {
    // Twenty short bullets are not a wall of text and keep their place.
    const many = Array.from({ length: 20 }, () => words(5));
    expect(splitMethodology(many).notes.length).toBe(0);
  });
});

describe("how many specs this touches", () => {
  // The threshold is a judgement, so pin what it actually does to the
  // corpus: a change that silently split half the site would be caught here.
  const dir = join(import.meta.dir, "../../benchmarks");
  const counts = readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => {
      const spec = load(readFileSync(join(dir, f), "utf8")) as {
        slug?: string;
        methodology?: string[];
      };
      return {
        slug: spec?.slug ?? f,
        split: splitMethodology(spec?.methodology).notes.length > 0,
      };
    });

  test("only a small minority of specs are split", () => {
    const split = counts.filter((c) => c.split);
    expect(split.length).toBeGreaterThan(0);
    // Well under a tenth of the corpus. If this trips, the threshold moved
    // or the specs grew, and either way it is a decision to make on purpose.
    expect(split.length).toBeLessThan(counts.length / 10);
  });

  test("the longest specs are among them", () => {
    // Bench 311, the spec that found this, was retired on 2026-11-02 when its
    // capability matrix moved to the chain RPC pages. The rule it exposed was
    // never about that spec: any methodology past the threshold is split.
    const split = counts.filter((c) => c.split).map((c) => c.slug);
    expect(split).toContain("perp-liq-rate");
    expect(split).toContain("terminal-fill-quality");
  });

  test("the threshold is the documented one", () => {
    expect(METHODOLOGY_SPLIT_WORDS).toBe(600);
  });
});
