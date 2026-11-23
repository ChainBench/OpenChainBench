import { describe, expect, it } from "bun:test";

import { injectLabels } from "@/lib/materialize/load";

/**
 * How a spec author excludes one value of a dimension decides whether the
 * dimension still works at all.
 *
 * `injectLabels` decides whether a selector already filters a label by
 * testing `\b<label>\s*=`. That test is true for `chain=~"..."` and false for
 * `chain!="..."`, so the two ways of writing "not Solana" behave in opposite
 * directions:
 *
 *   chain!="solana"         the label is NOT considered present, so the tab's
 *                           own `chain="ethereum"` is added beside it and the
 *                           dimension keeps working
 *   chain=~"ethereum|base"  the label IS considered present, nothing is
 *                           injected, and every chain tab silently publishes
 *                           the same all-chain number
 *
 * The allow-list reads as the safer shape, because it does not need updating
 * when a chain is added to the harness, and it is the one that disables the
 * dimension. openchainbench-21 reached for it on bench 311 and caught it by
 * running the real function.
 *
 * This applies to every spec with a dimension, not to that bench, which is
 * why it is pinned next to the loader rather than beside a bench.
 */
describe("injectLabels and the two ways to exclude a dimension value", () => {
  const labels = { chain: "ethereum" };

  it("adds the tab filter beside a negative matcher, so the dimension works", () => {
    const out = injectLabels('avg(m{provider="x",chain!="solana"})', labels);
    expect(out).toBe('avg(m{provider="x",chain!="solana",chain="ethereum"})');
    expect(out).toContain('chain="ethereum"');
  });

  it("injects NOTHING into a regex matcher, so every tab shows the same number", () => {
    const out = injectLabels('avg(m{provider="x",chain=~"ethereum|base"})', labels);
    // Unchanged: the tab's selection never reaches the query.
    expect(out).toBe('avg(m{provider="x",chain=~"ethereum|base"})');
    expect(out).not.toContain('chain="ethereum"');
  });

  it("treats a negated regex like the negative matcher, not like the regex one", () => {
    // The four spellings do split two and two, but not along the axis anyone
    // would guess. The presence test is `\b<label>\s*=`, so what decides is
    // whether the operator BEGINS with `=`:
    //
    //   chain=   chain=~   begin with `=`  -> read as already filtered
    //   chain!=  chain!~   do not          -> read as unfiltered, tab injected
    //
    // So `=~` groups with `=` and `!~` groups with `!=`, rather than regex
    // grouping with regex. An author reasoning by positive-versus-negative or
    // by exact-versus-regex gets it wrong either way.
    const out = injectLabels('avg(m{provider="x",chain!~"solana|polkadot"})', labels);
    expect(out).toContain('chain="ethereum"');
  });

  it("injects into a selector that filters nothing", () => {
    expect(injectLabels('avg(m{provider="x"})', labels)).toBe(
      'avg(m{provider="x",chain="ethereum"})',
    );
  });

  it("replaces a selector pinned to the dimension's all value rather than contradicting it", () => {
    expect(injectLabels('avg(m{provider="x",chain="all"})', labels)).toBe(
      'avg(m{provider="x",chain="ethereum"})',
    );
  });

  it("leaves an explicit pin to another value alone, which is how a panel opts out", () => {
    // A panel that deliberately fixes one chain keeps it: the presence test
    // sees `chain=` and adds nothing. This is the behaviour a cross-chain
    // reference column relies on, and it is the same mechanism that makes the
    // regex case fail, so it cannot be "fixed" without breaking this.
    expect(injectLabels('avg(m{provider="x",chain="bnb"})', labels)).toBe(
      'avg(m{provider="x",chain="bnb"})',
    );
  });
});
