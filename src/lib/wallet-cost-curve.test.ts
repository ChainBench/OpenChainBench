import { describe, expect, test } from "bun:test";
import {
  walletCostCurves,
  walletCostProfile,
  walletCostQuoteAt,
  walletCostRankAt,
} from "./wallet-cost-curve";

function provider(profile: string, slug: string) {
  const p = walletCostProfile(profile)?.providers.find((x) => x.slug === slug);
  if (!p) throw new Error(`no ${slug} on ${profile}`);
  return p;
}

describe("wallet-cost curve reader", () => {
  test("the committed artifact is the schema this build reads", () => {
    const f = walletCostCurves();
    expect(f).not.toBeNull();
    expect(f!.profiles.map((p) => p.id)).toEqual(["consumer", "active", "trading"]);
    expect(f!.volumes.map((v) => v.mau)).toEqual([1000, 10000, 100000]);
  });

  // Hand arithmetic from the vendors' pages, 2026-10-29.
  test("bills at the published volumes", () => {
    const at = (profile: string, slug: string, mau: number) => walletCostQuoteAt(provider(profile, slug), mau);
    // Reown Pro: $89 with 7,500 included, then $0.05.
    expect(at("consumer", "reown", 10000)).toMatchObject({ usd: 89 + 2500 * 0.05, plan: "pro" });
    // Dynamic Growth: $249 with 5,000 included, then $0.005.
    expect(at("trading", "dynamic", 100000)).toMatchObject({ usd: 249 + 95000 * 0.005, plan: "growth" });
    // Privy at exactly 10,000 users and 50,000 signatures is still Scale.
    expect(at("consumer", "privy", 10000)).toMatchObject({ usd: 499, plan: "scale" });
  });

  test("between two corners the bill is the straight line, and the plan is the segment's", () => {
    // Dynamic between 5,000 and 1,000,000 users is one affine piece.
    const q = walletCostQuoteAt(provider("consumer", "dynamic"), 20000);
    expect(q.usd).toBeCloseTo(249 + 15000 * 0.005, 6);
    // Web3Auth: Growth (69 + (u - 3000) x 0.045) and Scale
    // (399 + (u - 10000) x 0.04) cross where 0.005u = 65, at 13,000 users.
    // Either side of it the segment names its own plan, not the crossing
    // point's tie-break.
    const before = walletCostQuoteAt(provider("consumer", "web3auth"), 12000);
    expect(before).toMatchObject({ plan: "growth" });
    expect(before.usd).toBeCloseTo(69 + 9000 * 0.045, 6);
    const after = walletCostQuoteAt(provider("consumer", "web3auth"), 14000);
    expect(after).toMatchObject({ plan: "scale" });
    expect(after.usd).toBeCloseTo(399 + 4000 * 0.04, 6);
  });

  test("a vendor that cannot serve a size is unpriced with its own reason, never $0", () => {
    const { priced, unpriced } = walletCostRankAt("trading", 10000);
    const reown = unpriced.find((r) => r.slug === "reown");
    expect(reown?.reason).toContain("custom plan");
    expect(priced.find((r) => r.slug === "reown")).toBeUndefined();
    const turnkey = unpriced.find((r) => r.slug === "turnkey");
    expect(turnkey?.reason).toContain("no published price");
    for (const r of priced) expect(r.usd).not.toBeNull();
  });

  test("a caveat scoped to a volume only badges the price above it", () => {
    // thirdweb's bands are only ambiguous past 100,000 users.
    const below = walletCostRankAt("trading", 10000).priced.find((r) => r.slug === "thirdweb");
    const above = walletCostRankAt("trading", 200000).priced.find((r) => r.slug === "thirdweb");
    expect(below?.verified).toBe(true);
    expect(above?.verified).toBe(false);
  });

  test("ranking is cheapest first and stable on ties", () => {
    const { priced } = walletCostRankAt("consumer", 1000);
    const usd = priced.map((r) => r.usd ?? 0);
    expect([...usd].sort((a, b) => a - b)).toEqual(usd);
    // Four free plans tie at $0 at 1,000 users and come back by name.
    const free = priced.filter((r) => r.usd === 0).map((r) => r.name);
    expect(free).toEqual([...free].sort((a, b) => a.localeCompare(b)));
    expect(free.length).toBe(4);
  });
});
