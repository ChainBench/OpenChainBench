import { describe, expect, it } from "bun:test";
import {
  feedIsMostlyWhole,
  feedNeedsDisclosure,
  HL_WINDOWS,
  HL_WINDOW_LABEL,
} from "@/lib/hl-feed";

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
        nodeDays: 0,
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
        nodeDays: 30,
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
        nodeDays: 29,
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

describe("feedIsMostlyWhole", () => {
  const base = {
    coverageHours: 24,
    latestDayTruncated: false,
    truncatedDaysWindow: 0,
    daysMeasured: 30,
    windowDays: 30,
    nodeDays: 30,
  };

  // The live state on 2026-10-07 once the node source landed: 26 of 30 days
  // read whole off our own node, the other four being days the node was
  // down. The figures went from 0.53x of CoinMarketMan's to 0.89x, so the
  // page should footnote the gap rather than lead with it.
  it("treats a window that is nearly all node days as whole", () => {
    expect(feedIsMostlyWhole({ ...base, nodeDays: 26, truncatedDaysWindow: 3 })).toBe(true);
  });

  // The state before the node source: every day off the truncated export.
  it("does not soften a window built from the export", () => {
    expect(feedIsMostlyWhole({ ...base, nodeDays: 0, truncatedDaysWindow: 18 })).toBe(false);
  });

  // Half the window missing is not a footnote.
  it("does not soften a half-sourced window", () => {
    expect(feedIsMostlyWhole({ ...base, nodeDays: 15, truncatedDaysWindow: 9 })).toBe(false);
  });

  it("never softens an unmeasured feed", () => {
    expect(feedIsMostlyWhole(null)).toBe(false);
  });
});
