import { describe, expect, test } from "bun:test";
import {
  paymasterCurves,
  paymasterLeader,
  paymasterRankAt,
  paymasterScenario,
  paymasterQuoteAt,
} from "./paymaster-cost-curve";

function quote(scenario: string, slug: string, x: number) {
  const p = paymasterScenario(scenario)?.providers.find((v) => v.slug === slug);
  if (!p) throw new Error(`no ${slug} on ${scenario}`);
  return paymasterQuoteAt(p, x);
}

describe("paymaster curve reader", () => {
  test("the committed artifact is the schema this build reads", () => {
    const f = paymasterCurves();
    expect(f).not.toBeNull();
    expect(f!.scenarios.map((s) => s.id)).toEqual(["base", "arbitrum", "ethereum"]);
    expect(f!.headline).toEqual({ scenario: "base", size: "medium" });
  });

  // Hand arithmetic from the vendors' pages, 2026-10-30; gas excluded. 100,000
  // operations burn $200 of gas on Base, $15,000 on Ethereum.
  test("bills at the published sizes", () => {
    // 50M billing units, 10M free, $0.50 a million; 7% of $200.
    expect(quote("base", "coinbase-cdp", 100000).usd).toBeCloseTo(20 + 14, 6);
    // 1,050 credits an operation past 10M; $1 per 100,000; 10% of $15,000.
    expect(quote("ethereum", "pimlico", 100000).usd).toBeCloseTo(950 + 1500, 6);
    // No gas markup: 1,625 credits an operation at $1 per 250,000.
    expect(quote("ethereum", "etherspot", 10000)).toMatchObject({ usd: 65, bound: "upper" });
  });

  test("the leader changes with the chain", () => {
    expect(paymasterLeader(paymasterRankAt("base", 100000).priced)?.slug).toBe("coinbase-cdp");
    expect(paymasterLeader(paymasterRankAt("ethereum", 100000).priced)?.slug).toBe("thirdweb");
    expect(paymasterLeader(paymasterRankAt("ethereum", 10000).priced)?.slug).toBe("etherspot");
  });

  test("a lower-bound price is listed, never named", () => {
    // Circle's 5% leaves its per-wallet fee out: at least $10 on Base.
    const { priced } = paymasterRankAt("base", 100000);
    expect(priced[0]).toMatchObject({ slug: "circle", bound: "lower", verified: false });
    expect(paymasterLeader(priced)?.slug).not.toBe("circle");
  });

  test("an unpriced vendor carries its reason, never $0", () => {
    const { priced, unpriced } = paymasterRankAt("ethereum", 100000);
    expect(unpriced.map((r) => r.slug)).toEqual(expect.arrayContaining(["coinbase-cdp", "zerodev"]));
    expect(unpriced.find((r) => r.slug === "coinbase-cdp")?.reason).toContain("Base only");
    for (const r of priced) expect(r.usd).not.toBeNull();
  });
});
