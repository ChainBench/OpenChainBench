import { describe, expect, test } from "bun:test";
import {
  headToHead,
  shiftDay,
  windowSum,
  type PerpVolumeVenue,
} from "./perp-volume-history";

function venue(slug: string, series: Record<string, number>): PerpVolumeVenue {
  return {
    slug,
    name: slug,
    source: "test",
    days: Object.entries(series)
      .map(([day, usd]) => ({ day, usd }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}

describe("shiftDay", () => {
  test("crosses month boundaries in UTC", () => {
    expect(shiftDay("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftDay("2026-08-31", 1)).toBe("2026-09-01");
  });
});

describe("windowSum", () => {
  test("sums a complete window and refuses a short one", () => {
    const v = venue("a", { "2026-09-10": 1, "2026-09-11": 2, "2026-09-12": 3 });
    expect(windowSum(v, "2026-09-12", 3)).toBe(6);
    expect(windowSum(v, "2026-09-12", 4)).toBeNull();
    expect(windowSum(v, "2026-09-13", 1)).toBeNull();
  });
});

describe("headToHead", () => {
  test("anchors on the last day both venues have closed", () => {
    const a = venue("a", { "2026-09-10": 10, "2026-09-11": 30, "2026-09-12": 5, "2026-09-13": 9 });
    // b lags one day: 09-13 not closed yet.
    const b = venue("b", { "2026-09-10": 20, "2026-09-11": 20, "2026-09-12": 20 });
    const h = headToHead(a, b, 4);
    expect(h).not.toBeNull();
    expect(h!.asOf).toBe("2026-09-12");
    expect(h!.days.map((d) => d.lead)).toEqual([null, "b", "a", "b"]);
    expect(h!.window["1d"]).toEqual({ a: 5, b: 20 });
    expect(h!.window["7d"]).toEqual({ a: null, b: null });
    expect(h!.streak).toEqual({ side: "b", days: 1 });
    expect(h!.streakSince).toBe("2026-09-12");
  });

  test("counts a multi-day streak back to its first day", () => {
    const a = venue("a", { "2026-09-10": 1, "2026-09-11": 9, "2026-09-12": 9, "2026-09-13": 9 });
    const b = venue("b", { "2026-09-10": 5, "2026-09-11": 5, "2026-09-12": 5, "2026-09-13": 5 });
    const h = headToHead(a, b, 4)!;
    expect(h.streak).toEqual({ side: "a", days: 3 });
    expect(h.streakSince).toBe("2026-09-11");
    expect(h.daysLed30).toEqual({ a: 3, b: 1 });
  });

  test("returns null when a side has no history", () => {
    expect(headToHead(venue("a", {}), venue("b", { "2026-09-10": 1 }))).toBeNull();
  });
});
