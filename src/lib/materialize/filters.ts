/**
 * Filter-signature helpers for materialize/load.
 *
 * Pure, runtime-agnostic: used by both the Next.js site (cache key
 * material) and the standalone worker (variant fan-out). No persistence
 * or next/* dependencies.
 */

export type BenchmarkFilters = {
  chain?: string;
  region?: string;
  kind?: string;
};

export function filterSig(f: BenchmarkFilters): string {
  // Stable ordering, ignore "all" / undefined which mean "no filter".
  const parts: string[] = [];
  for (const k of Object.keys(f).sort()) {
    const v = (f as Record<string, string | undefined>)[k];
    if (v && v !== "all") parts.push(`${k}=${v}`);
  }
  return parts.join("&");
}

export function parseFilterSig(sig: string): BenchmarkFilters {
  const out: BenchmarkFilters = {};
  if (!sig) return out;
  for (const kv of sig.split("&")) {
    const [k, v] = kv.split("=");
    if (k && v && (k === "chain" || k === "region" || k === "kind")) {
      out[k as "chain" | "region" | "kind"] = v;
    }
  }
  return out;
}

export function activeFilterLabels(opts: BenchmarkFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (v && v !== "all") out[k] = v;
  }
  return out;
}
