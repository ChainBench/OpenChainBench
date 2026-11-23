import { describe, expect, test } from "bun:test";
import { feesFilter } from "@/lib/fees-filter";

describe("feesFilter", () => {
  test.each([
    [null, true, {}],
    ["included", true, {}],
    ["removed", true, { fees: "removed" }],
    [" Removed ", true, { fees: "removed" }],
    ["removed", false, null],
    ["none", true, null],
  ] as const)("%p with feesRemovable %p", (raw, feesRemovable, expected) => {
    expect(feesFilter(raw, { feesRemovable })).toEqual(expected);
  });
});
