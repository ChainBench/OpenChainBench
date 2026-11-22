import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { Benchmark } from "@/types/benchmark";

export function perpFeesSpecRaw(): unknown {
  return yaml.load(
    readFileSync(join(process.cwd(), "benchmarks/perp-fees.yml"), "utf8"),
  );
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
