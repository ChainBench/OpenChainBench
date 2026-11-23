import { describe, expect, test } from "bun:test";
import { pickOffPinView } from "./off-pin-view";
import type { Benchmark, ProviderResult } from "@/types/benchmark";

const row = (slug: string, p50: number): ProviderResult =>
  ({
    slug,
    name: slug,
    ms: { p50, p90: p50, p99: p50, mean: p50 },
    successRate: 1,
    sampleSize: 1000,
    availability: "live",
  }) as unknown as ProviderResult;

const bench = (rows: ProviderResult[], share?: Record<string, number>): Benchmark =>
  ({
    slug: "aggregator-head-lag",
    status: "live",
    higherIsBetter: false,
    results: rows,
    ...(share
      ? { raceLeader: { floor: 5, sharePanel: "first" }, metricPanels: [{ id: "first", label: "First to report", values: share }] }
      : {}),
  }) as unknown as Benchmark;

describe("pickOffPinView", () => {
  test("picks the tab where the provider ranks best, with that tab's rank and share", () => {
    const v = pickOffPinView(
      [
        { label: "BNB Chain", bench: bench([row("codex", 10), row("okx", 300), row("metastreams", 400)]) },
        { label: "Solana", bench: bench([row("codex", 1), row("metastreams", 20), row("okx", 250)], { metastreams: 12.4 }) },
      ],
      "Metastreams",
    );
    expect(v?.chainLabel).toBe("Solana");
    expect(v?.rank).toBe(2);
    expect(v?.totalRanked).toBe(3);
    expect(v?.raceShare?.share).toBe(12.4);
  });
  test("null when the provider is on no tab", () => {
    expect(pickOffPinView([{ label: "BNB Chain", bench: bench([row("codex", 10)]) }], "metastreams")).toBeNull();
  });
});
