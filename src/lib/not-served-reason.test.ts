import { describe, expect, test } from "bun:test";
import { notServedReason, priceReading, rankGateReason } from "./not-served-reason";

describe("notServedReason", () => {
  test("names each vendor's own reason for the view", () => {
    // Reown prices the consumer and active profiles; on trading it is out
    // by its own terms, at every size.
    expect(notServedReason("wallet-cost", "reown", { kind: "trading" })).toContain("custom plan");
    expect(notServedReason("wallet-cost", "reown", { kind: "trading", bucket: "1k" })).toContain("custom plan");
    // Turnkey on the default view (consumer, 10,000 users): its wallet cap.
    expect(notServedReason("wallet-cost", "turnkey", {})).toContain("2,000 wallets");
    // Crossmint at 1,000 consumer users fits its free 1,000 MAW but not its
    // 2,000 transactions.
    expect(notServedReason("wallet-cost", "crossmint", { bucket: "1k" })).toContain("2,000 transactions");
  });

  test("is null where the vendor is priced, and on other benches", () => {
    expect(notServedReason("wallet-cost", "reown", {})).toBeNull();
    expect(notServedReason("rpc-cost", "helius", {})).toBeNull();
  });
});

describe("notServedReason on bench 310", () => {
  test("names the vendor's own limit for the scenario and size", () => {
    // Turnkey holds at most 2,000 wallets on Pro: 10,000 agents is past it.
    expect(notServedReason("server-wallet-cost", "turnkey", {})).toContain("2,000 wallets");
    // Dfns Pro allows 10,000 signatures a month; a 100,000-transaction bot is past it.
    expect(notServedReason("server-wallet-cost", "dfns", { kind: "bot" })).toContain("on request");
    expect(notServedReason("server-wallet-cost", "thirdweb", {})).toBeNull();
  });
});

describe("rankGateReason", () => {
  test("names an 'at least' price that would rank first, and nothing else", () => {
    // Payouts at 10,000 wallets: Privy's $0 is a floor.
    expect(rankGateReason("server-wallet-cost", "privy", { kind: "payouts" })).toContain("at least");
    // A verified price, and another bench, keep the generic label.
    expect(rankGateReason("server-wallet-cost", "circle", { kind: "payouts" })).toBeNull();
    expect(rankGateReason("wallet-cost", "privy", {})).toBeNull();
  });
});

describe("priceReading", () => {
  test("carries the calculator's reading onto ledger rows", () => {
    // Agents at 10,000: thirdweb's bands are an upper bound, Lit a floor,
    // Circle's signing-only plan unambiguous.
    expect(priceReading("server-wallet-cost", "thirdweb", {})).toBe("at most");
    expect(priceReading("server-wallet-cost", "lit", {})).toBe("at least");
    expect(priceReading("server-wallet-cost", "circle", {})).toBeNull();
    // Bench 309 has no bound: Dynamic's two per-user rates read as ambiguous.
    expect(priceReading("wallet-cost", "dynamic", {})).toBe("ambiguous price");
    expect(priceReading("wallet-cost", "reown", {})).toBeNull();
    expect(priceReading("rpc-cost", "alchemy", {})).toBeNull();
  });
});
