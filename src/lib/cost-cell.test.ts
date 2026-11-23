import { describe, expect, test } from "bun:test";
import { costCell, renderCostCells } from "./cost-cell";
import { serverWalletRankAt } from "./server-wallet-cost-curve";
import { walletCostCurves, walletCostRankAt } from "./wallet-cost-curve";

describe("cost cells", () => {
  test("the leader is the calculator's, read from the curve", () => {
    // Bench 309, 10,000 consumer-app users: the cheapest verified price.
    const f = walletCostCurves()!;
    const mau = f.volumes.find((v) => v.id === "10k")!.mau;
    const first = walletCostRankAt("consumer", mau).priced.find((r) => r.verified)!;
    expect(costCell("wallet-cost", "consumer", "10k", "best_name")).toBe(first.name);
    // Bench 310: an upper bound may lead and carries its reading.
    const large = serverWalletRankAt("agents", 100000).priced[0]!;
    expect(large.bound).toBe("upper");
    expect(costCell("server-wallet-cost", "agents", "large", "best_usd")).toMatch(/^\$[\d,]+ at most$/);
  });

  test("a floor is never named, and its bill says so", () => {
    // Payouts at 10,000 wallets: Privy's $0 is a lower bound.
    expect(costCell("server-wallet-cost", "payouts", "medium", "best_name")).not.toContain("Privy");
    expect(costCell("server-wallet-cost", "payouts", "medium", "privy")).toBe("$0 on its published rates");
    expect(costCell("server-wallet-cost", "payouts", "small", "free_names")).not.toContain("Privy");
  });

  test("a vendor without a price says so; an unknown name is refused", () => {
    expect(costCell("server-wallet-cost", "agents", "medium", "turnkey")).toBe("no self-serve price");
    expect(costCell("server-wallet-cost", "agents", "medium", "nobody")).toBeNull();
    expect(costCell("server-wallet-cost", "agents", "huge", "best_name")).toBeNull();
    expect(costCell("rpc-cost", "a", "b", "best_name")).toBeNull();
  });

  test("bench 312 reads its own curve, chain by chain", () => {
    expect(costCell("paymaster-cost", "base", "medium", "best_name")).toBe("Coinbase CDP");
    expect(costCell("paymaster-cost", "ethereum", "small", "best_name")).toBe("Etherspot");
    // Circle's 5% leaves its wallet fee out: listed, never named.
    expect(costCell("paymaster-cost", "base", "medium", "circle")).toBe("at least $10");
    expect(costCell("paymaster-cost", "ethereum", "medium", "coinbase-cdp")).toBe("no self-serve price");
  });

  test("renders in prose and leaves other benches alone", () => {
    const s = "{{cell:bot:large:circle}} at Circle";
    expect(renderCostCells(s, "server-wallet-cost")).toBe("$0 at Circle");
    expect(renderCostCells(s, "rpc-cost")).toBe(s);
  });
});
