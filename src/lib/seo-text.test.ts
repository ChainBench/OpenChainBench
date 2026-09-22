import { describe, expect, test } from "bun:test";
import { capDescription } from "./seo-text";

// The 2026-09-22 audit found 5 of 29 sampled pages shipping a meta
// description cut mid-clause with an ellipsis, /products/mobula's
// "8 live benchmarks, 9…" among them. Google shows about 155 characters
// and 128 specs are written longer than that, so how the cut is made
// matters more than the cap.

describe("capDescription", () => {
  test("leaves a description that fits alone", () => {
    const s = "GMGN leads trading platforms at $112.66M 24h volume.";
    expect(capDescription(s, 158)).toBe(s);
  });

  test("cuts at a sentence end, not mid-clause", () => {
    const s =
      "Mobula reviewed across 8 live OpenChainBench benchmarks, 9 first-place finishes. " +
      "Latency, coverage and correctness measured live against every other provider in the cohort.";
    const out = capDescription(s, 158);
    expect(out.endsWith(".")).toBe(true);
    expect(out).not.toContain("…");
    expect(out.length).toBeLessThanOrEqual(158);
    expect(out).toBe("Mobula reviewed across 8 live OpenChainBench benchmarks, 9 first-place finishes.");
  });

  test("keeps every whole sentence that fits, not just the first", () => {
    const s = "One. Two. Three. " + "x".repeat(300);
    expect(capDescription(s, 40)).toBe("One. Two. Three.");
  });

  test("a first sentence longer than the budget still cuts at a word", () => {
    const s = "A single very long opening clause that runs past the budget without any full stop at all";
    const out = capDescription(s, 40);
    expect(out.endsWith("…")).toBe(true);
    // The kept text is a prefix of the input ending on a word boundary:
    // the ellipsis follows a whole word, never half of one.
    const kept = out.slice(0, -1);
    expect(s.startsWith(kept)).toBe(true);
    expect(s[kept.length]).toBe(" ");
  });
});
