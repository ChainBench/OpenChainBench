import { describe, expect, test } from "bun:test";
import { parseChainsHistory, parseValuationHistory, seriesForRange, seriesOn } from "./capital-history";

describe("parseValuationHistory", () => {
  test("keeps numeric fields per day, sorts days, drops malformed entries", () => {
    const h = parseValuationHistory({
      generated_at: "2026-09-25T10:00:00Z",
      protocols: [
        {
          slug: "gains-network",
          name: "Gains Network",
          category: "Derivatives",
          days: [
            { day: "2026-09-26", mcap: 12, pf: 1.7, note: "ignored" },
            { day: "2026-09-25", mcap: 11, pf: 1.6 },
            { day: 42, mcap: 1 },
          ],
        },
        { name: "no slug" },
      ],
      perps: "not a list",
    });
    expect(h).not.toBeNull();
    expect(h!.protocols).toHaveLength(1);
    expect(h!.perps).toHaveLength(0);
    const g = h!.protocols[0];
    expect(g.days.map((d) => d.day)).toEqual(["2026-09-25", "2026-09-26"]);
    expect(g.days[1].pf).toBe(1.7);
    expect("note" in g.days[1]).toBe(false);
  });

  test("refuses a blob without generated_at", () => {
    expect(parseValuationHistory({ protocols: [] })).toBeNull();
    expect(parseChainsHistory(null)).toBeNull();
  });
});

describe("seriesForRange", () => {
  test("answers only 90d and 1y, and only once the blob covers the whole grid", () => {
    const h = parseChainsHistory({
      generated_at: "x",
      chains: [{ slug: "base", days: [{ day: "2026-09-24", tvl: 5 }, { day: "2026-09-25", tvl: 6 }] }],
    });
    const base = h!.chains[0];
    expect(seriesForRange(base, "tvl", "7d", ["2026-09-24", "2026-09-25"])).toBeNull();
    expect(seriesForRange(base, "tvl", "30d", ["2026-09-24", "2026-09-25"])).toBeNull();
    // 90d grid starting before the first stored day: not covered yet.
    expect(seriesForRange(base, "tvl", "90d", ["2026-09-23", "2026-09-24", "2026-09-25"])).toBeNull();
    // grid inside the stored span: served.
    expect(seriesForRange(base, "tvl", "90d", ["2026-09-24", "2026-09-25"])).toEqual([5, 6]);
    expect(seriesForRange(base, "tvl", "1y", ["2026-09-25"])).toEqual([6]);
  });
});

describe("seriesOn", () => {
  test("maps a field onto the grid and returns null when nothing lands", () => {
    const h = parseChainsHistory({
      generated_at: "x",
      chains: [{ slug: "base", days: [{ day: "2026-09-24", tvl: 5, bridged_tvl: 9 }, { day: "2026-09-25", tvl: 6 }] }],
    });
    const base = h!.chains[0];
    const grid = ["2026-09-23", "2026-09-24", "2026-09-25"];
    expect(seriesOn(base, "tvl", grid)).toEqual([null, 5, 6]);
    expect(seriesOn(base, "bridged_tvl", grid)).toEqual([null, 9, null]);
    expect(seriesOn(base, "revenue_30d", grid)).toBeNull();
    expect(seriesOn(undefined, "tvl", grid)).toBeNull();
  });
});
