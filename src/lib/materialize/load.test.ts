import { describe, expect, test } from "bun:test";
import { unresponsiveResult } from "./load";
import type { Spec } from "@/lib/spec-schema";

type SpecProvider = Spec["providers"][number];

const provider: SpecProvider = {
  slug: "cloudflare",
  name: "Cloudflare",
  tag: "Permissioned-mode for many JSON-RPC methods",
  formula: "p50 of eth_blockNumber round-trip",
} as SpecProvider;

describe("unresponsiveResult", () => {
  test("null when the provider was not provably probed (no counters)", () => {
    // A provider that doesn't cover the current chain/region slice, or a
    // bench without success/sample_size queries: must NOT fake-offline.
    expect(unresponsiveResult(provider, { success: null, sampleSize: null })).toBeNull();
    expect(unresponsiveResult(provider, { success: null, sampleSize: 0 })).toBeNull();
  });

  test("flags a probed provider whose ok-rate series is entirely absent", () => {
    // Cloudflare on ethereum: rpc_call_total keeps counting, but zero ok
    // samples in the window makes the success division come back empty.
    const r = unresponsiveResult(provider, { success: null, sampleSize: 8641 });
    expect(r).not.toBeNull();
    expect(r!.unresponsive).toBe(true);
    expect(r!.availability).toBe("unavailable");
    expect(r!.successRate).toBe(0);
    expect(r!.sampleSize).toBe(8641);
    expect(r!.ms).toEqual({ p50: 0, p90: 0, p99: 0, mean: 0 });
  });

  test("flags a probed provider with a near-zero success ratio", () => {
    // 1RPC with its IP quota exhausted: ~1.7% of calls succeed.
    const r = unresponsiveResult(provider, { success: 0.0169, sampleSize: 8643 });
    expect(r).not.toBeNull();
    expect(r!.unresponsive).toBe(true);
    expect(r!.successRate).toBeCloseTo(1.69, 2);
  });

  test("null when the success rate is healthy (transient percentile miss)", () => {
    // Latency comes from the same probes as OK results — a healthy
    // success rate next to a null p50 is a transient Prom read failure,
    // not a dead endpoint. Must not badge.
    expect(unresponsiveResult(provider, { success: 0.998, sampleSize: 8640 })).toBeNull();
    // Same input already expressed in percent (legacy formulas).
    expect(unresponsiveResult(provider, { success: 99.8, sampleSize: 8640 })).toBeNull();
  });

  test("carries provider identity fields through", () => {
    const r = unresponsiveResult(provider, { success: 0, sampleSize: 100 });
    expect(r!.slug).toBe("cloudflare");
    expect(r!.name).toBe("Cloudflare");
    expect(r!.tag).toBe(provider.tag);
    expect(r!.formula).toBe(provider.formula);
  });
});
