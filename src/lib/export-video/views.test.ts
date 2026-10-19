import { describe, expect, test } from "bun:test";
import { viewsForMetric } from "./types";

describe("viewsForMetric", () => {
  test("no Donut for metrics that do not add up", () => {
    expect(viewsForMetric("ms", false)).not.toContain("DonutRace");
    expect(viewsForMetric("s", false)).not.toContain("DonutRace");
    expect(viewsForMetric("pct", false)).not.toContain("DonutRace");
    expect(viewsForMetric("usd", false)).not.toContain("DonutRace");
  });
  test("Donut for counts and dollar volumes", () => {
    expect(viewsForMetric("count", true)).toContain("DonutRace");
    expect(viewsForMetric("usd", true)).toContain("DonutRace");
  });
  test("ranked bars always available", () => {
    expect(viewsForMetric("ms", false)).toContain("BarChartRace");
  });
});
