import { describe, expect, it } from "bun:test";
import {
  feedIsMostlyWhole,
  feedNeedsDisclosure,
  HL_WINDOWS,
  HL_WINDOW_LABEL,
  hlDaySources,
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
        rebuiltDays: 0,
        rebuiltWorstErrorPct: 0,
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
        rebuiltDays: 0,
        rebuiltWorstErrorPct: 0,
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
        rebuiltDays: 0,
        rebuiltWorstErrorPct: 0,
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
    rebuiltDays: 0,
    rebuiltWorstErrorPct: 0,
  };

  // The live state on 2026-10-07 once the node source landed: 26 of 30 days
  // read whole off our own node, the other four being days the node was
  // down. The figures went from 0.53x of CoinMarketMan's to 0.89x, so the
  // page should footnote the gap rather than lead with it.
  it("treats a window that is nearly all node days as whole", () => {
    expect(
      feedIsMostlyWhole({ ...base, nodeDays: 26, truncatedDaysWindow: 3 }),
    ).toBe(true);
  });

  // The state before the node source: every day off the truncated export.
  it("does not soften a window built from the export", () => {
    expect(
      feedIsMostlyWhole({ ...base, nodeDays: 0, truncatedDaysWindow: 18 }),
    ).toBe(false);
  });

  // Half the window missing is not a footnote.
  it("does not soften a half-sourced window", () => {
    expect(
      feedIsMostlyWhole({ ...base, nodeDays: 15, truncatedDaysWindow: 9 }),
    ).toBe(false);
  });

  it("never softens an unmeasured feed", () => {
    expect(feedIsMostlyWhole(null)).toBe(false);
  });
});

// The disclosure's own trigger does not know about rebuilt days: a window whose
// every day is nominally whole passes feedNeedsDisclosure quietly, and that is
// precisely the window that may be carrying reconstructions. If the note keyed
// only on truncation it would print nothing and publish a rebuilt day as a
// measured one, which is the single failure the note exists to prevent.
//
// The component therefore renders on `truncation || rebuiltDays > 0`. This pins
// the half that is testable here: truncation alone goes quiet.
describe("rebuilt days are not covered by the truncation trigger", () => {
  const whole = {
    coverageHours: 24,
    latestDayTruncated: false,
    truncatedDaysWindow: 0,
    daysMeasured: 30,
    windowDays: 30,
    nodeDays: 25,
    rebuiltDays: 5,
    rebuiltWorstErrorPct: 0,
  };

  it("says nothing about a window of whole days, rebuilt or not", () => {
    expect(feedNeedsDisclosure(whole)).toBe(false);
    expect(feedNeedsDisclosure({ ...whole, rebuiltDays: 0 })).toBe(false);
  });

  // So the count has to survive the read, or the component has nothing to key
  // on. A rebuilt day is never folded into nodeDays either: 25 + 5 = 30 here,
  // and nodeDays alone must not claim the window is measured.
  it("keeps rebuilt days out of the node-day count", () => {
    expect(whole.nodeDays).toBe(25);
    expect(whole.nodeDays + whole.rebuiltDays).toBe(whole.windowDays);
  });
});

describe("hlDaySources", () => {
  // The live shape at 12:40 UTC on 2026-10-25, the first pass of a harness
  // binary that actually carried the node substitution. The note's old
  // sentence took the export's share as windowDays - nodeDays, which is 12
  // here, and then described 11 truncated days as a subset of it. Two days
  // rest on the export. Ten are reconstructions, which the note reports on
  // their own line precisely so they are not read as measurements.
  const live = {
    coverageHours: 23.9,
    latestDayTruncated: false,
    truncatedDaysWindow: 11,
    daysMeasured: 30,
    windowDays: 30,
    nodeDays: 18,
    rebuiltDays: 10,
    rebuiltWorstErrorPct: -35.2,
  };

  it("keeps rebuilt days out of the export's share", () => {
    expect(hlDaySources(live)).toEqual({
      nodeDays: 18,
      rebuiltDays: 10,
      exportDays: 2,
    });
  });

  it("splits the whole window and nothing more", () => {
    const s = hlDaySources(live);
    expect(s.nodeDays + s.rebuiltDays + s.exportDays).toBe(live.windowDays);
  });

  // A scrape landing mid-pass can pair a node count from the new window with
  // a rebuilt count from the old. The remainder is clamped rather than
  // allowed to go negative, because "-3 days are left on the export" is a
  // worse thing to publish than a conservative zero.
  it("never returns a negative remainder", () => {
    const s = hlDaySources({ ...live, nodeDays: 28, rebuiltDays: 9 });
    expect(s.exportDays).toBe(0);
    expect(s.rebuiltDays).toBe(2);
    expect(s.nodeDays + s.rebuiltDays + s.exportDays).toBe(30);
  });

  // The state the page was in from 2026-10-07 to 2026-10-25: the harness
  // image was rebuilt from a source tree frozen before the node code landed,
  // so the deployed binary never set the gauge and every day did rest on the
  // export. That reading has to stay describable, because a rollback or a
  // node outage reproduces it.
  it("hands the whole window to the export when the node reports nothing", () => {
    expect(hlDaySources({ ...live, nodeDays: 0, rebuiltDays: 0 })).toEqual({
      nodeDays: 0,
      rebuiltDays: 0,
      exportDays: 30,
    });
  });
});
