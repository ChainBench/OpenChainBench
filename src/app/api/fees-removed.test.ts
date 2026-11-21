import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Benchmark } from "@/types/benchmark";
import type { BenchmarkFilters } from "@/lib/materialize/load";
import { perpFeesBoard } from "@/test/benchmark";

const ALL_IN_7D = [7, 7];
const SPREAD_7D = [2, 2];

function bench(metric: string): Benchmark {
  return perpFeesBoard({
    metric,
    feesRemovable: true,
    results: [
      {
        slug: "lighter",
        name: "Lighter",
        availability: "live",
        ms: { p50: 3, p90: 3, p99: 3, mean: 3 },
        successRate: 100,
      },
    ],
    extras: { series24h: { lighter: [3, 3] }, regions: {} },
  });
}

let feesVariant: Benchmark | undefined;
let blobReads = 0;

beforeEach(() => {
  feesVariant = undefined;
  blobReads = 0;
  mock.module("@/data/benchmarks", () => ({
    getBenchmark: async (_slug: string, f: BenchmarkFilters = {}) =>
      f.fees ? feesVariant : bench("All-in cost"),
  }));
  mock.module("next/cache", () => ({
    unstable_cache: <T,>(fn: T) => fn,
  }));
  mock.module("@/lib/bench-blob", () => ({
    loadSnapshotFromBlob: async (_slug: string, sig: string) => {
      blobReads += 1;
      const series7d = sig.includes("fees=removed") ? SPREAD_7D : ALL_IN_7D;
      return {
        bench: {
          ...bench("All-in cost"),
          extras: {
            series24h: {},
            regions: {},
            series7d: { lighter: series7d },
          },
        },
      };
    },
  }));
});

afterEach(() => {
  mock.restore();
});

async function variant(query: string): Promise<Response> {
  const mod = await import("./bench/[slug]/variant/route");
  const req = new Request(
    `https://example.test/api/bench/perp-fees/variant?${query}`,
  );
  return mod.GET(req as unknown as Parameters<typeof mod.GET>[0], {
    params: Promise.resolve({ slug: "perp-fees" }),
  });
}

async function series(query: string): Promise<Response> {
  const mod = await import("./series/[slug]/route");
  const req = new Request(`https://example.test/api/series/perp-fees?${query}`);
  return mod.GET(req as unknown as Parameters<typeof mod.GET>[0], {
    params: Promise.resolve({ slug: "perp-fees" }),
  });
}

describe("fees=removed before the worker has published it", () => {
  test("the variant route answers 404 instead of the all-in board", async () => {
    const res = await variant("fees=removed");

    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("the series route answers 404 instead of all-in labels", async () => {
    const res = await series("range=7d&raw=1&fees=removed");

    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(blobReads).toBe(0);
  });

  test("an unknown fees value is refused", async () => {
    expect((await variant("fees=maybe")).status).toBe(400);
  });
});

describe("fees=removed once published", () => {
  test("the variant route serves the fees-removed board", async () => {
    feesVariant = bench("Spread + impact");

    const res = await variant("fees=removed");

    expect(res.status).toBe(200);
    expect((await res.json()).metric).toBe("Spread + impact");
  });

  test("the series route serves fees-removed history under its metric", async () => {
    feesVariant = bench("Spread + impact");

    const res = await series("range=7d&raw=1&fees=removed");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.metric).toBe("Spread + impact");
    expect(body.providers[0].values).toEqual(SPREAD_7D);
  });
});
