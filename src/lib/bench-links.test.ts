import { expect, test } from "bun:test";
import { benchOgImage, benchPageUrl } from "./bench-links";

test.each([
  [undefined, "/benchmarks/perp-fees", "/api/og/perp-fees"],
  [
    "dex" as const,
    "/benchmarks/perp-fees?venue_type=dex",
    "/api/og/perp-fees?venue_type=dex",
  ],
])("links of a %p page", (venueType, page, image) => {
  expect(benchPageUrl("perp-fees", venueType).endsWith(page)).toBe(true);
  expect(benchOgImage("perp-fees", venueType).endsWith(image)).toBe(true);
});
