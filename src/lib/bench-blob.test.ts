import { describe, expect, test } from "bun:test";
import { fromProvidersWire, toProvidersWire } from "./bench-blob";
import type { ProviderProfile } from "./providers";

const bench = (slug: string) =>
  ({ slug, title: slug, subtitle: "", category: "RPCs", metric: "p50", unit: "ms", higherIsBetter: false, status: "live", lastRunAt: "x", hasDistribution: true }) as ProviderProfile["appearances"][number]["benchmark"];
const result = { slug: "a", name: "A", ms: { p50: 1, p90: 1, p99: 1, mean: 1 }, successRate: 100 } as ProviderProfile["appearances"][number]["result"];

describe("providers wire format", () => {
  test("round-trips and de-duplicates bench descriptors", () => {
    const profiles: ProviderProfile[] = [
      { slug: "a", name: "A", wins: 1, categories: ["RPCs"], appearances: [
        { benchmark: bench("x"), result, rank: 1, totalRanked: 3 },
        { benchmark: bench("y"), result, rank: 2, totalRanked: 3 },
      ] },
      { slug: "b", name: "B", wins: 0, categories: ["RPCs"], appearances: [
        { benchmark: bench("x"), result, rank: 2, totalRanked: 3 },
      ] },
    ];
    const wire = toProvidersWire(profiles, 123);
    expect(wire.v).toBe(2);
    expect(Object.keys(wire.benches).sort()).toEqual(["x", "y"]);
    expect(wire.providers[0].appearances[0]).toEqual({ b: "x", result, rank: 1, totalRanked: 3 });
    expect(fromProvidersWire(wire)).toEqual(profiles);
  });

  test("drops an appearance whose bench descriptor is missing instead of throwing", () => {
    const wire = { v: 2 as const, builtAt: 0, benches: {}, providers: [{ slug: "a", name: "A", wins: 0, categories: [], appearances: [{ b: "ghost", result, rank: 1, totalRanked: 1 }] }] };
    expect(fromProvidersWire(wire)[0].appearances).toEqual([]);
  });
});
