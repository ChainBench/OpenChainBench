import { describe, expect, test } from "bun:test";
import { isRankedOnView } from "./load";

describe("isRankedOnView", () => {
  const rankedOn = { kind: ["sol", "eth", "bnb"] };
  test("a listed tab ranks the row", () => {
    expect(isRankedOnView(rankedOn, { kind: "sol" })).toBe(true);
  });
  test("the All tab and unlisted tabs keep it unranked", () => {
    expect(isRankedOnView(rankedOn, {})).toBe(false);
    expect(isRankedOnView(rankedOn, { kind: "btc" })).toBe(false);
  });
  test("no ranked_on means unranked everywhere", () => {
    expect(isRankedOnView(undefined, { kind: "sol" })).toBe(false);
  });
});
