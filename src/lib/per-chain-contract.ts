/**
 * Per-chain contract bridge.
 *
 * Agent 1 owns the shared contract additions in `src/types/benchmark.ts`
 * (the `bestPerChain` field on `Benchmark`) and `src/lib/spec.ts`
 * (the `bestForChain` helper). When those land on the parent branch, the
 * fields are part of the canonical type and this file's augmentation
 * becomes redundant (still type-compatible — fields with identical
 * definitions merge cleanly under declaration merging).
 *
 * This module exists so the products + badge surface (this agent's lane)
 * can compile against the contract WITHOUT having to touch
 * `src/types/benchmark.ts` or `src/lib/spec.ts` — both forbidden files.
 *
 * Once Agent 1's branch is merged, this file becomes a no-op but is left
 * in place to centralize the contract documentation and the runtime
 * accessor helpers that depend on it.
 */

import type { Benchmark, ProviderResult } from "@/types/benchmark";

declare module "@/types/benchmark" {
  interface BenchmarkPerChainExtension {
    /** Per-chain leader stash (chain slug → leader ProviderResult). */
    bestPerChain?: Record<string, ProviderResult>;
  }
}

/**
 * Read-only accessor for `bestPerChain` that tolerates the field being
 * absent (e.g. during the merge window when Agent 1's branch hasn't
 * landed yet). Returns undefined when the bench doesn't expose
 * per-chain data, never throws.
 */
export function readBestPerChain(
  b: Benchmark,
): Record<string, ProviderResult> | undefined {
  // The field is optional on the type once Agent 1's PR lands; until then
  // the structural access is the safe path.
  const v = (b as unknown as { bestPerChain?: Record<string, ProviderResult> })
    .bestPerChain;
  return v && typeof v === "object" ? v : undefined;
}

/**
 * Mirrors Agent 1's `bestForChain` helper. Pure lookup with no Prom call;
 * the per-chain leaders are precomputed at spec-load time.
 */
export function bestForChain(
  b: Benchmark,
  chain: string,
): ProviderResult | undefined {
  return readBestPerChain(b)?.[chain];
}
