import { describe, expect, test } from "bun:test";
import { parseHistory } from "../lib/snapshot";

describe("parseHistory", () => {
  test("last line of a day wins, torn lines are skipped, sorted by day", () => {
    const raw = [
      '{"day":"2026-09-02","visitors7d":10}',
      '{"day":"2026-09-01","visitors7d":5}',
      '{"day":"2026-09-02","visi',
      '{"day":"2026-09-02","visitors7d":12}',
      "",
    ].join("\n");
    const h = parseHistory(raw);
    expect(h.map((l) => l.day)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(h[1].visitors7d).toBe(12);
  });
  test("empty file", () => {
    expect(parseHistory("")).toEqual([]);
  });
});
