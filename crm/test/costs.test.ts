import { describe, expect, test } from "bun:test";
import { dayTotal, foldCharges, parseCharges, railwayCost, shapeCosts, sumUsage } from "../lib/costs";

const OCB = "prj_ocb";
const line = (o: Record<string, unknown>) => JSON.stringify({ ChargePeriodStart: "2026-11-04T08:00:00.000Z", EffectiveCost: 1, ServiceName: "x", Tags: {}, ...o });

describe("vercel charges", () => {
  test("keeps the OCB project and the untagged team charges, drops other projects", () => {
    const body = [
      line({ ServiceName: "ISR Writes", EffectiveCost: 1.55, Tags: { ProjectId: OCB, ProjectName: "openchainbench" } }),
      line({ ServiceName: "ISR Writes", EffectiveCost: 0.45, Tags: { ProjectId: OCB } }),
      line({ ServiceName: "Fluid Active CPU", EffectiveCost: 1.07, Tags: { ProjectId: "prj_mobula", ProjectName: "mobula-monorepo-mtt" } }),
      line({ ServiceName: "Flat Rate CDN 50M", EffectiveCost: 3.226, Tags: {} }),
      line({ ServiceName: "Pro", EffectiveCost: 0.645 }),
      line({ ServiceName: "Speed Insights", EffectiveCost: 0, Tags: { ProjectId: OCB } }),
      // Start of a cycle: billed 0 against the plan credit, still a cost of the day.
      line({ ServiceName: "Observability Events", EffectiveCost: 1.37, BilledCost: 0, Tags: { ProjectId: OCB } }),
      "not json",
      "",
    ].join("\n");
    const { services, fixed } = foldCharges(parseCharges(body), OCB);
    expect(services["2026-11-04"]["ISR Writes"]).toBeCloseTo(2);
    expect(services["2026-11-04"]["Observability Events"]).toBeCloseTo(1.37);
    expect(fixed["2026-11-04"]["Flat Rate CDN 50M"]).toBeCloseTo(3.226);
    expect(fixed["2026-11-04"].Pro).toBeCloseTo(0.645);
    expect(Object.keys(fixed["2026-11-04"])).not.toContain("Fluid Active CPU");
  });
});

describe("railway usage", () => {
  test("several rows per measurement add up rather than overwrite", () => {
    // Found 2026-10-27: assigning instead of summing kept the last row and
    // was off by a factor of ten.
    const u = sumUsage([
      { measurement: "CPU_USAGE", value: 600 },
      { measurement: "CPU_USAGE", value: 418.39 },
      { measurement: "MEMORY_USAGE_GB", value: 7960.93 },
      { measurement: "NETWORK_TX_GB", value: 13.96 },
      { measurement: "DISK_USAGE_GB", value: 11775.77 },
      { measurement: "UNKNOWN", value: 99 },
    ]);
    expect(u.CPU_USAGE).toBeCloseTo(1018.39);
    // The OCB prod project on 2026-11-04: about three dollars.
    expect(railwayCost(u)).toBeCloseTo(0.4715 + 1.839 + 0.698 + 0.0409, 2);
  });
});

describe("shaping", () => {
  test("a day Vercel has not billed is null, not zero, and the total adds every source", () => {
    const c = shapeCosts({
      today: "2026-11-06",
      railwayProjects: ["prod", "staging"],
      railwayUsage: {
        "2026-11-04": { prod: { NETWORK_TX_GB: 20 }, staging: { NETWORK_TX_GB: 10 } },
        "2026-11-06": { prod: { NETWORK_TX_GB: 4 } },
        "2025-01-01": { prod: { NETWORK_TX_GB: 999 } },
      },
      vercelServicesByDay: { "2026-11-04": { "ISR Writes": 1.5, "Fluid Active CPU": 0.5 } },
      vercelFixedByDay: { "2026-11-04": { Pro: 0.65 } },
    });
    expect(c.days.map((d) => d.day)).toEqual(["2026-11-04", "2026-11-06"]);
    const [billed, today] = c.days;
    expect(dayTotal(billed)).toBeCloseTo(2 + 0.65 + 1 + 0.5);
    expect(today.vercelProject).toBeNull();
    expect(today.railway.prod).toBeCloseTo(0.2);
    // Outside the window: dropped from the store as well as the series.
    expect(c.railwayUsage["2025-01-01"]).toBeUndefined();
    expect(c.vercelServices7d[0]).toEqual({ name: "ISR Writes", cost: 1.5 });
  });
});
