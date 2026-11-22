import { describe, expect, test } from "bun:test";
import { venueScopeErrors } from "./venue-scope";

const dex = {
  venueType: "dex",
  bench: "perp-fees",
  venueTyped: true,
};

const fieldsOf = (errors: { field: string }[]) => errors.map((e) => e.field);

describe("venueScopeErrors", () => {
  test.each([
    ["plain live tokens", "{{best_name}} at {{best_p50}}, {{count}} venues", 0],
    ["a provider token", "{{name:lighter}} at {{p50:lighter}}", 0],
    ["a chain leader", "ETH leader {{best_name:chain:ETH}}", 1],
    ["a tier count", "{{count:tier:keyed}} keyed endpoints", 1],
  ])("%s", (_, text, expected) => {
    expect(venueScopeErrors(dex, [["intro", text]])).toHaveLength(expected);
  });

  test("one error per field that reads a cohort leader", () => {
    const errors = venueScopeErrors(dex, [
      ["intro", "{{best_p50:chain:SOL}}"],
      ["faq[0].a", undefined],
      ["seo_title", "{{worst_name:chain:BTC}}"],
    ]);
    expect(fieldsOf(errors)).toEqual(["intro", "seo_title"]);
  });

  test.each([
    ["an unscoped answer", { ...dex, venueType: undefined }, []],
    ["an unknown venue type", { ...dex, venueType: "spot" }, ["venue_type"]],
    [
      "a bench with no typed provider",
      { ...dex, venueTyped: false },
      ["venue_type", "intro"],
    ],
  ])("%s", (_, scope, expected) => {
    const errors = venueScopeErrors(scope, [["intro", "{{count:tier:x}}"]]);
    expect(fieldsOf(errors)).toEqual(expected);
  });
});
