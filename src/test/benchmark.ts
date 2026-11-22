import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type {
  Benchmark,
  ProviderResult,
  ProviderVenueType,
} from "@/types/benchmark";

export function perpFeesSpecRaw(): unknown {
  return yaml.load(
    readFileSync(join(process.cwd(), "benchmarks/perp-fees.yml"), "utf8"),
  );
}

export function perpFeesRow(
  slug: string,
  venueType?: ProviderVenueType,
  p50 = 5,
): ProviderResult {
  return {
    name: slug,
    slug,
    venueType,
    ms: { p50, p90: p50, p99: p50, mean: p50 },
    successRate: 100,
    sampleSize: 10,
  };
}

export function perpFeesBoard(over: Partial<Benchmark> = {}): Benchmark {
  return {
    slug: "perp-fees",
    number: "007",
    title: "Perp fees",
    subtitle: "",
    abstract: "",
    metric: "All-in cost",
    unit: "bps",
    higherIsBetter: false,
    sampleSize: 288,
    lastRunAt: "2026-11-21T00:00:00.000Z",
    status: "live",
    editorialStatus: "live",
    category: "Trading",
    results: [],
    findings: [],
    methodology: [],
    source: "",
    extras: { series24h: {}, regions: {} },
    ...over,
  };
}
