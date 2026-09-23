import { describe, expect, it } from "bun:test";
import { countRows, nounFor, nounLabel, rowNoun } from "@/lib/row-noun";

describe("rowNoun", () => {
  it("falls back to provider when a bench does not declare one", () => {
    expect(rowNoun(undefined)).toEqual({ one: "provider", many: "providers" });
    expect(rowNoun({})).toEqual({ one: "provider", many: "providers" });
    expect(nounFor({}, 4)).toBe("providers");
  });

  it("agrees with the count", () => {
    const chains = { rowNoun: { one: "chain", many: "chains" } };
    expect(nounFor(chains, 1)).toBe("chain");
    expect(nounFor(chains, 41)).toBe("chains");
    expect(countRows(chains, 41)).toBe("41 chains");
    expect(countRows(chains, 1)).toBe("1 chain");
    // A zero cohort still reads as a plural, which is what the sentence
    // "across 0 ranked chains" needs.
    expect(countRows(chains, 0)).toBe("0 chains");
  });

  it("title-cases the label for a column header", () => {
    expect(nounLabel({ rowNoun: { one: "venue", many: "venues" } })).toBe("Venues");
    expect(nounLabel({})).toBe("Providers");
  });
});

describe("the sentence bench 273 shipped wrong", () => {
  it("names chains, not providers", () => {
    // The live text was "across 41 ranked providers" on a board of
    // blockchains, in the one sentence the page marks data-llm-canonical.
    const b = { rowNoun: { one: "chain", many: "chains" } };
    expect(`across 41 ranked ${nounFor(b, 41)}.`).toBe("across 41 ranked chains.");
  });
});
