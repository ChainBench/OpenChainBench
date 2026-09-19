import { describe, expect, test } from "bun:test";
import { SpecSchema } from "./spec-schema";

function specWith(endpoint: string) {
  return {
    slug: "x-rpc", number: "999", title: "Fastest free X RPC, live no-key endpoint latency",
    subtitle: "s", category: "RPCs", status: "live", metric: "RPC latency", unit: "ms", higher_is_better: false,
    abstract: "a".repeat(60), methodology: ["m"], source: "https://github.com/ChainBench/OpenChainBench",
    prometheus: { window: "24h" },
    providers: [{ slug: "p", name: "P", endpoint, queries: { p50: "up", p90: "up", p99: "up", series: "up" } }],
  };
}

describe("provider.endpoint accepts public URLs only", () => {
  test("public no-key endpoints pass", () => {
    for (const u of ["https://arbitrum-one-rpc.publicnode.com", "https://eth.drpc.org", "https://solana.leorpc.com/?api_key=FREE", "https://gateway.tenderly.co/public/arbitrum"]) {
      expect(SpecSchema.safeParse(specWith(u)).success).toBe(true);
    }
  });
  test("keyed shapes are refused", () => {
    for (const u of [
      "https://eth-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz",
      "https://stylish-patient.robinhood-mainnet.quiknode.pro/0123456789abcdef0123456789abcdef01234567/",
      "https://rpc.example.com/v3/123e4567-e89b-12d3-a456-426614174000",
      "https://ethereum-mainnet.core.chainstack.com/0123456789abcdef0123456789abcdef",
      "https://go.getblock.io/0123456789abcdef0123456789abcdef",
      "https://rpc.example.com/?api_key=sk_live_123456789012",
      "https://rpc.example.com/?token=abcdefghijklmnop",
      "http://public-rpc.example.com",
    ]) {
      expect(SpecSchema.safeParse(specWith(u)).success).toBe(false);
    }
  });
});
