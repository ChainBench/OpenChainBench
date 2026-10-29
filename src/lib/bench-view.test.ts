import { describe, expect, test } from "bun:test";
import { defaultViewLabel } from "./bench-view";

describe("defaultViewLabel", () => {
  test("names the default slice of every non-chain axis, in a fixed order", () => {
    expect(
      defaultViewLabel({
        dimensions: {
          bucket: [
            { value: "all", label: "10,000 users" },
            { value: "1k", label: "1,000 users" },
          ],
          kind: [
            { value: "all", label: "Consumer app, 5 transactions a user" },
            { value: "trading", label: "Trading app" },
          ],
        },
      }),
    ).toBe("Consumer app, 5 transactions a user · 10,000 users");
  });

  test("is empty for chain, region and tier benches, and for single-value axes", () => {
    expect(defaultViewLabel({})).toBe("");
    expect(
      defaultViewLabel({
        dimensions: {
          chain: [
            { value: "all", label: "All chains" },
            { value: "base", label: "Base" },
          ],
          kind: [{ value: "all", label: "Only one" }],
        },
      }),
    ).toBe("");
  });
});
