import { describe, expect, test } from "bun:test";
import { fmtHeadline } from "./format";

const race = {
  unit: "ms",
  raceLeader: { floor: 0.5, sharePanel: "first_share" },
  metricPanels: [{ id: "first_share", values: { getblock: 89.4 } }],
};

describe("fmtHeadline", () => {
  test("a race winner's zero reads first, with its share of wins", () => {
    expect(fmtHeadline(0.28, race, "getblock")).toBe("first · 89%");
  });
  test("without a share it still does not print a latency", () => {
    expect(fmtHeadline(0.28, race, "dwellir")).toBe("first");
  });
  test("a trailing provider keeps its lag", () => {
    expect(fmtHeadline(233, race, "dwellir")).not.toContain("first");
  });
  test("a bench without race_leader is unchanged", () => {
    expect(fmtHeadline(0.28, { unit: "ms" }, "getblock")).not.toContain("first");
  });
});
