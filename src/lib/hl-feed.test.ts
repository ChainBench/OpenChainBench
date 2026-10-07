import { describe, expect, it } from "bun:test";
import { feedNeedsDisclosure, HL_WINDOWS, HL_WINDOW_LABEL } from "@/lib/hl-feed";

describe("feedNeedsDisclosure", () => {
  // The real shape on 2026-10-07: Hyperliquid's per-builder export carried
  // 12.2 of 24 hours on the latest day and cut 18 of the window's 30 days
  // short, which is why every 30d figure read about half of CoinMarketMan's.
  it("discloses a window the feed cut short", () => {
    expect(
      feedNeedsDisclosure({
        coverageHours: 12.16,
        latestDayTruncated: true,
        truncatedDaysWindow: 17,
        daysMeasured: 24,
        windowDays: 30,
      }),
    ).toBe(true);
  });

  it("stays quiet on a whole feed", () => {
    expect(
      feedNeedsDisclosure({
        coverageHours: 24,
        latestDayTruncated: false,
        truncatedDaysWindow: 0,
        daysMeasured: 30,
        windowDays: 30,
      }),
    ).toBe(false);
  });

  // The window can be clean while the day in progress is not, which is the
  // state the morning after the feed starts truncating.
  it("discloses a short latest day even with a clean window", () => {
    expect(
      feedNeedsDisclosure({
        coverageHours: 12.16,
        latestDayTruncated: true,
        truncatedDaysWindow: 0,
        daysMeasured: 30,
        windowDays: 30,
      }),
    ).toBe(true);
  });

  // Not measured is not the same claim as measured whole. A harness too old
  // to publish the coverage gauges is exactly the state this note exists for,
  // so an absent measurement must not render as reassurance.
  it("discloses when coverage was never measured", () => {
    expect(feedNeedsDisclosure(null)).toBe(true);
  });
});

describe("window labels", () => {
  // "24h" is the last complete UTC feed day, not a rolling 24 hours, and
  // every builder is measured on the same day. A column headed "24h" would
  // promise the wrong thing.
  it("never calls the feed day 24h", () => {
    expect(HL_WINDOW_LABEL["24h"]).toBe("feed day");
  });

  it("labels every window it declares", () => {
    for (const w of HL_WINDOWS) {
      expect(HL_WINDOW_LABEL[w]).toBeTruthy();
    }
  });
});
