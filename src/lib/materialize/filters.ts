/**
 * Filter-signature helpers for materialize/load.
 *
 * Pure, runtime-agnostic: used by both the Next.js site (cache key
 * material) and the standalone worker (variant fan-out). No persistence
 * or next/* dependencies.
 */

import { isAll, type DimensionValue } from "@/lib/dimensions";

export type BenchmarkFilters = {
  chain?: DimensionValue;
  region?: DimensionValue;
  kind?: DimensionValue;
  venue?: DimensionValue;
};

export function filterSig(f: BenchmarkFilters): string {
  // Stable ordering, ignore "all" / undefined which mean "no filter".
  const parts: string[] = [];
  for (const k of Object.keys(f).sort()) {
    const v = (f as Record<string, string | undefined>)[k];
    if (v && !isAll(v)) parts.push(`${k}=${v}`);
  }
  return parts.join("&");
}

export function parseFilterSig(sig: string): BenchmarkFilters {
  const out: BenchmarkFilters = {};
  if (!sig) return out;
  for (const kv of sig.split("&")) {
    const [k, v] = kv.split("=");
    if (k && v && (k === "chain" || k === "region" || k === "kind" || k === "venue")) {
      out[k as "chain" | "region" | "kind" | "venue"] = v;
    }
  }
  return out;
}

export function activeFilterLabels(opts: BenchmarkFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (v && !isAll(v)) out[k] = v;
  }
  return out;
}
