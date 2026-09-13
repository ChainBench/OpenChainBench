import { beforeEach, describe, expect, test } from "bun:test";
import { acquireRevalidateSlot, minIntervalSec, _resetLocalThrottle } from "./revalidate-throttle";

describe("acquireRevalidateSlot", () => {
  beforeEach(() => _resetLocalThrottle());

  test("first caller wins, later callers inside the interval are dropped (shared lock)", async () => {
    const held = new Set<string>();
    const setNx = async (k: string) => (held.has(k) ? false : (held.add(k), true));
    expect(await acquireRevalidateSlot(600, { setNx })).toBe(true);
    expect(await acquireRevalidateSlot(600, { setNx })).toBe(false);
    expect(await acquireRevalidateSlot(600, { setNx })).toBe(false);
  });

  test("interval 0 disables the throttle", async () => {
    const setNx = async () => false;
    expect(await acquireRevalidateSlot(0, { setNx })).toBe(true);
  });

  test("falls back to the local clock when the lock store throws", async () => {
    const setNx = async () => { throw new Error("upstash down"); };
    let t = 1_000_000;
    const now = () => t;
    expect(await acquireRevalidateSlot(600, { setNx, now })).toBe(true);
    expect(await acquireRevalidateSlot(600, { setNx, now })).toBe(false);
    t += 601_000;
    expect(await acquireRevalidateSlot(600, { setNx, now })).toBe(true);
  });
});

describe("minIntervalSec", () => {
  test("unset or empty env means the default, not zero", () => {
    expect(minIntervalSec(undefined)).toBe(600);
    expect(minIntervalSec("")).toBe(600);
    expect(minIntervalSec("  ")).toBe(600);
    expect(minIntervalSec("abc")).toBe(600);
  });
  test("explicit values are honoured, including 0 to disable", () => {
    expect(minIntervalSec("0")).toBe(0);
    expect(minIntervalSec("300")).toBe(300);
  });
});
