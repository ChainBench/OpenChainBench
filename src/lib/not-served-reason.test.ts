import { describe, expect, test } from "bun:test";
import { notServedReason } from "./not-served-reason";

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
