import { describe, expect, test } from "bun:test";
import { offPinCoverage } from "./off-pin-coverage";

const chainDimensions = [
  { value: "base", label: "Base" },
  { value: "bnb", label: "BNB Chain" },
  { value: "solana", label: "Solana" },
  { value: "robinhood", label: "Robinhood" },
];
const cellRanks = {
  "base|us-east": [{ slug: "codex", p50: 0.04 }],
  "base|all": [{ slug: "codex", p50: 0.04 }],
  "bnb|eu-west": [{ slug: "codex", p50: 0.01 }, { slug: "metastreams", p50: 0.4 }],
  "solana|all": [{ slug: "codex", p50: 0 }, { slug: "metastreams", p50: 0.02 }],
  "all|eu-west": [{ slug: "metastreams", p50: 0.2 }],
};

describe("offPinCoverage", () => {
  test("a provider absent from the pinned chain lists the chains it is measured on", () => {
    expect(offPinCoverage({ pinnedChain: "base", chainDimensions, cellRanks }, "Metastreams")).toEqual({
      pinnedLabel: "Base",
      chains: ["BNB Chain", "Solana"],
    });
  });
  test("a provider measured on the pinned chain keeps the old label", () => {
    expect(offPinCoverage({ pinnedChain: "base", chainDimensions, cellRanks }, "codex")).toBeNull();
  });
  test("a provider with no cell anywhere keeps the old label", () => {
    expect(offPinCoverage({ pinnedChain: "base", chainDimensions, cellRanks }, "birdeye")).toBeNull();
  });
  test("a bench without a pinned chain is untouched", () => {
    expect(offPinCoverage({ chainDimensions, cellRanks }, "metastreams")).toBeNull();
  });
});
