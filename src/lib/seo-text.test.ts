import { describe, expect, test } from "bun:test";
import { capDescription, capSnippet } from "./seo-text";

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

describe("capSnippet: cut placement (RWA audit 2026-09-23)", () => {
  test("does not treat an abbreviation's period as a sentence end", () => {
    const s =
      "USDY ranks #1 of 4 on RWA yield deviation at 2.00 bps (30d avg). 1 live benchmark, 1 first-place finish. Ondo USDY is a yield-bearing tokenized U.S. Treasury note for non-US holders, accruing daily.";
    const out = capSnippet(s);
    expect(out.endsWith("U.S..")).toBe(false);
    expect(out.endsWith("U.S.")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(155);
  });

  test("never cuts inside a parenthesis", () => {
    const s =
      "Does USDY trade at its NAV? Live basis between Ondo's tokenized treasury market price (Orca pool, Jupiter route) and the redemption price Ondo publishes onchain, in bps.";
    const out = capSnippet(s);
    expect((out.match(/\(/g) ?? []).length).toBe((out.match(/\)/g) ?? []).length);
    expect(out).not.toContain("(Orca pool.");
  });
});

test("capSnippet: a stray closing parenthesis costs no character", () => {
  const s = "Alpha) beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega alpha beta gamma delta epsilon zeta eta theta iota.";
  const out = capSnippet(s);
  expect(out.startsWith("Alpha) beta")).toBe(true);
  expect(out.length).toBeLessThanOrEqual(155);
});

describe("capSnippet uses the budget it is given", () => {
  // The shape that shipped 62 characters of a 155 allowance: a short
  // opening sentence, then a longer one carrying the detail. Two of the
  // WebSocket pages lost the second sentence whole, and with it the only
  // mention of the five providers being compared.
  const two =
    "QuickNode pushes BNB Chain blocks first on the private cohort. " +
    "Per-block WebSocket lag for Chainstack, GetBlock, QuickNode, Dwellir " +
    "and Validation Cloud, measured from 3 regions.";

  test("does not cut at a sentence end far below the cap", () => {
    const out = capSnippet(two);
    expect(out.length).toBeGreaterThan(100);
    expect(out.length).toBeLessThanOrEqual(156);
    expect(out).toContain("Chainstack");
  });

  test("still cuts at the sentence end when that lands near the cap", () => {
    const s =
      "Chainstack leads this chain at 2.1 ms over 24 hours across three probe regions worldwide today. " +
      "A second sentence, long enough that keeping it would overflow the budget entirely.";
    expect(capSnippet(s).endsWith("today.")).toBe(true);
  });

  test("never exceeds the cap and never ends on punctuation noise", () => {
    for (const n of [160, 200, 400]) {
      const out = capSnippet("word, ".repeat(n));
      expect(out.length).toBeLessThanOrEqual(156);
      expect(out).not.toMatch(/[,;:\s]\.$/);
    }
  });
});
