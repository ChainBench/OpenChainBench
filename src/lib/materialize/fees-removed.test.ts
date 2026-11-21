import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { loadSpecsUncached, specToBenchmark } from "@/lib/materialize/load";
import type { Spec } from "@/lib/spec-schema";

const ALL_IN = 7;
const SPREAD = 3;
const TIER = 11;

function sampleFor(query: string): number | null {
  if (query.includes("perp_fees_health")) return 1;
  if (query.includes("count_over_time")) return 288;
  if (query.includes("perp_fees_all_in_bps_tier")) return TIER;
  if (query.includes("perp_fees_spread_bps")) return SPREAD;
  if (query.includes("perp_fees_all_in_bps")) return ALL_IN;
  return null;
}

let server: ReturnType<typeof Bun.serve>;
let queries: string[] = [];
let perpFees: Spec;
let view: NonNullable<Spec["fees_removed"]>;
const previousUrl = process.env.PROMETHEUS_URL;

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const query = url.searchParams.get("query") ?? "";
      queries.push(query);
      if (url.pathname === "/api/v1/query_range") {
        return Response.json({
          status: "success",
          data: { resultType: "matrix", result: [] },
        });
      }
      const value = sampleFor(query);
      return Response.json({
        status: "success",
        data: {
          resultType: "vector",
          result:
            value === null
              ? []
              : [{ metric: {}, value: [Date.now() / 1000, String(value)] }],
        },
      });
    },
  });
  process.env.PROMETHEUS_URL = `http://127.0.0.1:${server.port}`;
  const specs = await loadSpecsUncached();
  const found = specs.find((s) => s.slug === "perp-fees");
  if (!found?.fees_removed) throw new Error("perp-fees fees_removed view not found");
  perpFees = found;
  view = found.fees_removed;
});

afterAll(() => {
  server.stop(true);
  process.env.PROMETHEUS_URL = previousUrl;
});

beforeEach(() => {
  queries = [];
});

const panelIds = (fees: "included" | "removed") =>
  (perpFees.metric_panels ?? [])
    .filter((p) => (p.fees ?? fees) === fees)
    .map((p) => p.id);

describe("perp-fees with trading fees removed", () => {
  test("ranks spread plus impact and swaps the all-in panels", async () => {
    const b = await specToBenchmark(perpFees, { fees: "removed", chain: "BTC" });

    const lighter = b.results.find((r) => r.slug === "lighter");
    expect(lighter?.ms.p50).toBe(SPREAD);
    expect(lighter?.formula).toBe(view.formula);
    expect(b.metric).toBe(view.metric);
    expect(b.panelMainLabel).toBe(view.panel_main_label);
    expect(b.metricPanels?.map((p) => p.id)).toEqual(panelIds("removed"));
    expect(queries).toContain(
      'avg_over_time(perp_fees_spread_bps{venue="lighter",chain="BTC"}[24h])',
    );
    expect(queries.filter((q) => /perp_fees_all_in_bps\{|fees=/.test(q))).toEqual([]);
  });

  test("lists the oracle-priced venues unranked", async () => {
    const b = await specToBenchmark(perpFees, { fees: "removed", chain: "BTC" });

    const label = (slug: string) =>
      b.results.find((r) => r.slug === slug)?.unrankedLabel;
    expect(label("gmx")).toBe(view.unranked?.gmx);
    expect(label("gains")).toBe(view.unranked?.gains);
    expect(label("lighter")).toBeUndefined();
  });

  test("leaves the default view on the all-in figures", async () => {
    const b = await specToBenchmark(perpFees, {});

    expect(b.results.find((r) => r.slug === "lighter")?.ms.p50).toBe(ALL_IN);
    expect(b.results.find((r) => r.slug === "gmx")?.unrankedLabel).toBeUndefined();
    expect(b.metric).toBe(perpFees.metric);
    expect(b.metricPanels?.map((p) => p.id)).toEqual(panelIds("included"));
    expect(b.metricPanels?.[0]?.values.lighter).toBe(TIER);
    expect(b.feesRemovable).toBe(true);
  });
});
