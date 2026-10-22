import { describe, expect, test } from "bun:test";
import { noFigureLabel, noRankLabel } from "./no-figure-label";

describe("no-figure labels", () => {
  // Helius, Syndica and Triton sell Solana only; on the cost benches' Ethereum
  // default view their product page must not promise a rank that never comes.
  test("the RPC cost benches say not ranked, not awaiting", () => {
    expect(noRankLabel("rpc-cost")).toBe("not ranked");
    expect(noRankLabel("rpc-free-tier")).toBe("not ranked");
    expect(noFigureLabel("rpc-cost")).toBe("no Ethereum dapp plan");
  });

  test("a latency bench still says awaiting", () => {
    expect(noRankLabel("aggregator-head-lag")).toBe("awaiting");
    expect(noFigureLabel("aggregator-head-lag")).toBe("data warming up");
  });
});
