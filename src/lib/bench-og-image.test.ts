import { expect, test } from "bun:test";
import { benchOgImage } from "./bench-og-image";

test.each([
  [undefined, "/api/og/perp-fees"],
  ["dex" as const, "/api/og/perp-fees?venue_type=dex"],
])("the share image of a %p page", (venueType, path) => {
  expect(benchOgImage("perp-fees", venueType).endsWith(path)).toBe(true);
});
