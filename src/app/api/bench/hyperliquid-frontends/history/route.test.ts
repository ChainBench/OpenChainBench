import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ArchiveSnapshot } from "@/types/hl-archive";
import type { Benchmark } from "@/types/benchmark";

/** Stub Benchmark with the panel ids the route reads from. Only the fields
 *  the route touches are populated; everything else is a sensible zero so
 *  the test cannot depend on unrelated spec state. */
function stubBench(): Benchmark {
  return {
    slug: "hyperliquid-frontends",
    number: "27",
    title: "HL frontends",
    subtitle: "",
    abstract: "",
    metric: "Builder fees collected (USD)",
    unit: "usd",
    higherIsBetter: true,
    sampleSize: 0,
    lastRunAt: "2026-06-25T00:00:00.000Z",
    status: "live",
    editorialStatus: "live",
    category: "Trading",
    results: [
      {
        slug: "phantom",
        name: "Phantom",
        availability: "live",
        ms: { p50: 1000, p90: 100_000, p99: 0, mean: 0 },
        successRate: 100,
      },
      {
        slug: "metamask",
        name: "MetaMask",
        availability: "live",
        ms: { p50: 500, p90: 50_000, p99: 0, mean: 0 },
        successRate: 100,
      },
      {
        slug: "offline-thing",
        name: "Offline",
        availability: "unavailable",
        ms: { p50: 0, p90: 0, p99: 0, mean: 0 },
        successRate: 0,
      },
    ],
    findings: [],
    methodology: [],
    source: "",
    extras: { series24h: {}, regions: {} },
    metricPanels: [
      {
        id: "revenue_7d",
        label: "Revenue 7d",
        metric: "hl_frontend_fees_usd_7d_v2",
        unit: "usd",
        higherIsBetter: true,
        tab: false,
        values: { phantom: 7_000, metamask: 3_500 },
      },
      {
        id: "volume_7d",
        label: "Volume 7d",
        metric: "hl_frontend_volume_usd_7d_v2",
        unit: "usd",
        higherIsBetter: true,
        tab: false,
        values: { phantom: 700_000, metamask: 350_000 },
      },
      {
        id: "revenue_30d",
        label: "Revenue 30d",
        metric: "hl_frontend_fees_usd_30d_v2",
        unit: "usd",
        higherIsBetter: true,
        tab: false,
        values: { phantom: 30_000, metamask: 15_000 },
      },
      {
        id: "volume_30d",
        label: "Volume 30d",
        metric: "hl_frontend_volume_usd_30d_v2",
        unit: "usd",
        higherIsBetter: true,
        tab: false,
        values: { phantom: 3_000_000, metamask: 1_500_000 },
      },
    ],
  };
}

function archive(): ArchiveSnapshot {
  return {
    updated_at: "2026-06-25T00:00:00.000Z",
    builders: {
      "0xphantom": {
        name: "Phantom",
        windows: {
          "1y": { volume_usd: 9_000_000, fees_usd: 90_000, fills: 12_000 },
          all: { volume_usd: 18_000_000, fees_usd: 180_000, fills: 25_000 },
        },
      },
      "0xmetamask": {
        name: "MetaMask",
        windows: {
          "1y": { volume_usd: 4_500_000, fees_usd: 45_000, fills: 6_000 },
          all: { volume_usd: 8_000_000, fees_usd: 80_000, fills: 11_000 },
        },
      },
      "0xempty": {
        name: "Empty",
        windows: {
          "1y": { volume_usd: 0, fees_usd: 0, fills: 0 },
        },
      },
    },
  };
}

// Carriers the per-test stubs flip to drive the route's two branches. The
// module mocks below read from these on every call, so each `test` block
// fully controls what getBenchmark / getArchive return for its run.
let benchOverride: Benchmark | null | undefined = undefined;
let archiveOverride: ArchiveSnapshot | null | undefined = undefined;

beforeEach(() => {
  benchOverride = stubBench();
  archiveOverride = archive();
  mock.module("@/data/benchmarks", () => ({
    getBenchmark: async () => benchOverride ?? null,
  }));
  mock.module("@/lib/hl-archive-store", () => ({
    getArchive: async () => archiveOverride ?? null,
    hlArchiveConfigured: () => true,
    HL_ARCHIVE_KEY: "ocb:hl-archive:v1",
  }));
  // Stub rate-limit so each test starts with a fresh budget.
  mock.module("@/lib/rate-limit", () => ({
    rateLimit: () => ({ ok: true, retryAfterSec: 0 }),
    clientKey: () => "test",
    tooManyRequests: () => new Response("rate", { status: 429 }),
  }));
});

afterEach(() => {
  mock.restore();
});

async function call(window: string): Promise<{ status: number; body: unknown }> {
  const mod = await import("./route");
  const req = new Request(
    `https://example.test/api/bench/hyperliquid-frontends/history?window=${window}`,
  );
  // The route imports NextRequest at the type-level only; passing a
  // plain Request through `as unknown as Parameters<typeof mod.GET>[0]`
  // exercises the same code path Next.js takes at runtime.
  const res = await mod.GET(req as unknown as Parameters<typeof mod.GET>[0]);
  const body = await res.json();
  return { status: res.status, body };
}

describe("GET /api/bench/hyperliquid-frontends/history", () => {
  test("rejects unknown window with 400", async () => {
    const r = await call("42h");
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: "bad_window" });
  });

  test("24h reads headline slots and ranks by volume", async () => {
    const r = await call("24h");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      window: "24h",
      source: "prom",
      rows: [
        { slug: "phantom", volume_usd: 100_000, fees_usd: 1_000, rank: 1 },
        { slug: "metamask", volume_usd: 50_000, fees_usd: 500, rank: 2 },
      ],
    });
  });

  test("7d reads the revenue_7d and volume_7d panels", async () => {
    const r = await call("7d");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      window: "7d",
      source: "prom",
      rows: [
        { slug: "phantom", volume_usd: 700_000, fees_usd: 7_000 },
        { slug: "metamask", volume_usd: 350_000, fees_usd: 3_500 },
      ],
    });
  });

  test("30d reads the revenue_30d and volume_30d panels", async () => {
    const r = await call("30d");
    expect(r.status).toBe(200);
    expect((r.body as { source: string }).source).toBe("prom");
    expect((r.body as { rows: { volume_usd: number }[] }).rows[0].volume_usd).toBe(
      3_000_000,
    );
  });

  test("1y reads the archive and ranks by volume", async () => {
    const r = await call("1y");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      window: "1y",
      source: "archive",
      rows: [
        {
          slug: "0xphantom",
          name: "Phantom",
          volume_usd: 9_000_000,
          fees_usd: 90_000,
          fills: 12_000,
          rank: 1,
        },
        {
          slug: "0xmetamask",
          volume_usd: 4_500_000,
          rank: 2,
        },
      ],
    });
  });

  test("all returns 503 with archive_pending when archive missing", async () => {
    archiveOverride = null;
    const r = await call("all");
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: "archive_pending", window: "all" });
  });

  test("short windows fall back to 503 when the bench is gone", async () => {
    benchOverride = null;
    const r = await call("24h");
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: "bench_unavailable" });
  });
});
