import { describe, expect, test } from "bun:test";
import { staysOpen, takesFocus } from "@/app/api-access/board-rules";

const places = {
  body: { name: "body" },
  pressed: { name: "pressed button" },
  banner: { name: "banner" },
};

describe("the outcome banner", () => {
  test.each([
    ["nothing has focus", true, null],
    ["the page body has focus", true, places.body],
    ["the pressed control still has focus", true, places.pressed],
    ["it already has focus", true, places.banner],
    ["the operator moved to another field", false, { name: "reason" }],
  ])("when %s, taking focus is %p", (_, expected, active) => {
    expect(takesFocus(active, places)).toBe(expected);
  });
});

describe("a confirmation", () => {
  test.each([
    ["was never opened", false, null, "outcome-1"],
    ["is open and not sent", true, { sentWith: null }, "outcome-2"],
    ["was sent and waits", true, { sentWith: "outcome-1" }, "outcome-1"],
    ["was sent and its outcome came", false, { sentWith: "outcome-1" },
      "outcome-2"],
  ])("that %s stays open: %p", (_, expected, opened, resetKey) => {
    expect(staysOpen(opened, resetKey)).toBe(expected);
  });
});
