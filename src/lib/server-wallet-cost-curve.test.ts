import { describe, expect, test } from "bun:test";
import {
  serverWalletCurves,
  serverWalletLeader,
  serverWalletRankAt,
  serverWalletScenario,
  serverWalletQuoteAt,
} from "./server-wallet-cost-curve";

function quote(scenario: string, slug: string, x: number) {
  const p = serverWalletScenario(scenario)?.providers.find((v) => v.slug === slug);
  if (!p) throw new Error(`no ${slug} on ${scenario}`);
  return serverWalletQuoteAt(p, x);
}

describe("server wallet curve reader", () => {
  test("the committed artifact is the schema this build reads", () => {
    const f = serverWalletCurves();
    expect(f).not.toBeNull();
    expect(f!.scenarios.map((s) => s.id)).toEqual(["agents", "bot", "payouts"]);
    expect(f!.headline).toEqual({ scenario: "agents", size: "medium" });
  });

  // Hand arithmetic from the vendors' pages, 2026-10-29.
  test("bills at the published sizes", () => {
    // 10,000 agents x 50 = 500,000 requests = 500 thousand: $99 + 99 x $1
    // + 150 x $0.60 + 250 x $0.20.
    expect(quote("agents", "thirdweb", 10000)).toMatchObject({ usd: 99 + 99 + 90 + 50, bound: "upper" });
    // A bot's 20 wallets sit in Circle's free 1,000 at any volume.
    expect(quote("bot", "circle", 1000000)).toMatchObject({ usd: 0 });
    // CDP: 2 operations a transaction, 5,000 free, $0.005 each.
    expect(quote("payouts", "coinbase-cdp", 10000).usd).toBeCloseTo((40000 - 5000) * 0.005, 6);
  });

  test("an upper-bound price may lead, a lower-bound one may not", () => {
    // Agents at 100,000: thirdweb is cheapest and its ambiguity only lowers
    // its bill, so it leads.
    const { priced } = serverWalletRankAt("agents", 100000);
    expect(priced[0]?.slug).toBe("thirdweb");
    expect(priced[0]?.bound).toBe("upper");
    expect(serverWalletLeader(priced)?.slug).toBe("thirdweb");
    // Agents at 10,000: Circle's signing-only plan, verified, at $327.
    const ten = serverWalletRankAt("agents", 10000).priced;
    expect(ten[0]).toMatchObject({ slug: "circle", plan: "signing-api", verified: true });
    expect(ten[0]?.usd).toBeCloseTo(4000 * 0.038 + 5000 * 0.035, 6);
    // Payouts at 10,000: Privy's $0 is a lower bound (its unpriced $1M
    // volume clause), so the named leader is the next price that holds.
    const pay = serverWalletRankAt("payouts", 10000).priced;
    expect(pay[0]?.slug).toBe("privy");
    expect(pay[0]?.bound).toBe("lower");
    expect(serverWalletLeader(pay)?.slug).not.toBe("privy");
  });

  test("an unpriced vendor carries its reason, never $0", () => {
    const { priced, unpriced } = serverWalletRankAt("agents", 10000);
    expect(unpriced.map((r) => r.slug)).toContain("turnkey");
    for (const r of priced) expect(r.usd).not.toBeNull();
  });
});
