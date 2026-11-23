import { describe, expect, test } from "bun:test";
import { costRanks } from "./cost-rank";
import { serverWalletRankAt } from "./server-wallet-cost-curve";
import { paymasterRankAt } from "./paymaster-cost-curve";

describe("the pricing benches' one ranking rule", () => {
  test("a lower bound above the leader keeps its place, as the ledger gives it", () => {
    // 10,000 agents: Lit ($5,000 at least) and Privy ($6,500 at least) sit
    // above Circle's $327, so all eight priced rows rank, Portal last.
    const { priced } = serverWalletRankAt("agents", 10000);
    const { ranked, floors, rankOf } = costRanks(priced);
    expect(floors).toHaveLength(0);
    expect(ranked).toHaveLength(priced.length);
    const portal = priced.find((r) => r.slug === "portal")!;
    expect(rankOf(portal)).toBe(priced.length);
  });

  test("a lower bound at or under the leader is listed, not ranked", () => {
    // Payouts at 10,000 wallets: Privy's $0 is a floor under the leader.
    const { priced } = serverWalletRankAt("payouts", 10000);
    const { leader, floors, rankOf } = costRanks(priced);
    expect(leader?.slug).not.toBe("privy");
    const privy = priced.find((r) => r.slug === "privy")!;
    expect(floors).toContain(privy);
    expect(rankOf(privy)).toBe(0);
    expect(rankOf(leader!)).toBe(1);
    // Bench 312, Base at 100,000: Circle's 5% leaves its wallet fee out.
    const base = costRanks(paymasterRankAt("base", 100000).priced);
    expect(base.leader?.slug).toBe("coinbase-cdp");
    expect(base.floors.map((r) => r.slug)).toEqual(["circle"]);
  });
});
