import { describe, expect, test } from "bun:test";
import { latestIso, fmtTs, decideWinner, parseAdHocSlug, canonicalisationTarget } from "./compare-compute";

describe("latestIso", () => {
  test("returns the most recent ISO string from a list", () => {
    const items = [
      { ts: "2026-01-01T00:00:00.000Z" },
      { ts: "2026-06-15T12:00:00.000Z" },
      { ts: "2026-03-10T00:00:00.000Z" },
    ];
    expect(latestIso(items, (x) => x.ts)).toBe("2026-06-15T12:00:00.000Z");
  });

  test("returns null for empty list", () => {
    expect(latestIso([], (x: { ts: string }) => x.ts)).toBeNull();
  });

  test("skips null/undefined picks", () => {
    const items = [
      { ts: null as string | null },
      { ts: "2026-05-01T00:00:00.000Z" },
      { ts: undefined as string | undefined },
    ];
    expect(latestIso(items, (x) => x.ts)).toBe("2026-05-01T00:00:00.000Z");
  });

  test("returns null when all picks are null", () => {
    const items = [{ ts: null }, { ts: null }];
    expect(latestIso(items, (x) => x.ts)).toBeNull();
  });

  test("single item returns that item's timestamp", () => {
    expect(
      latestIso([{ ts: "2026-07-01T00:00:00.000Z" }], (x) => x.ts),
    ).toBe("2026-07-01T00:00:00.000Z");
  });

  test("works with plain string array via identity pick", () => {
    const strs = [
      "2025-12-31T23:59:59.000Z",
      "2026-01-01T00:00:00.000Z",
      "2025-06-15T00:00:00.000Z",
    ];
    expect(latestIso(strs, (s) => s)).toBe("2026-01-01T00:00:00.000Z");
  });

  test("two equal timestamps returns either (both same)", () => {
    const ts = "2026-07-15T10:00:00.000Z";
    expect(latestIso([{ ts }, { ts }], (x) => x.ts)).toBe(ts);
  });
});

describe("fmtTs", () => {
  test("formats a valid ISO string as UTC", () => {
    const out = fmtTs("2026-07-15T14:30:00.000Z");
    expect(out).not.toBeNull();
    expect(out).toContain("UTC");
    expect(out).toContain("2026");
  });

  test("returns null for null input", () => {
    expect(fmtTs(null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(fmtTs(undefined)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(fmtTs("")).toBeNull();
  });

  test("output replaces GMT with UTC", () => {
    const out = fmtTs("2026-01-01T00:00:00.000Z");
    expect(out).not.toContain("GMT");
    expect(out).toContain("UTC");
  });
});

describe("decideWinner", () => {
  test("tie when p50s are equal", () => {
    expect(decideWinner(100, 100, false)).toBe("tie");
    expect(decideWinner(100, 100, true)).toBe("tie");
  });

  test("lower-is-better: lower p50 wins", () => {
    expect(decideWinner(50, 100, false)).toBe("a");
    expect(decideWinner(100, 50, false)).toBe("b");
  });

  test("higher-is-better: higher p50 wins", () => {
    expect(decideWinner(200, 100, true)).toBe("a");
    expect(decideWinner(100, 200, true)).toBe("b");
  });

  test("zero vs positive: zero loses in lower-is-better", () => {
    expect(decideWinner(0, 100, false)).toBe("a");
  });

  test("zero vs positive: zero loses in higher-is-better", () => {
    expect(decideWinner(0, 100, true)).toBe("b");
  });
});

describe("parseAdHocSlug", () => {
  test("parses a simple a-vs-b slug", () => {
    expect(parseAdHocSlug("ethereum-vs-solana")).toEqual({ a: "ethereum", b: "solana" });
  });

  test("handles hyphenated provider names", () => {
    expect(parseAdHocSlug("helius-rpc-vs-alchemy")).toEqual({
      a: "helius-rpc",
      b: "alchemy",
    });
  });

  test("returns null when delimiter is absent", () => {
    expect(parseAdHocSlug("no-delimiter-here")).toBeNull();
  });

  test("returns null when delimiter is at position 0 (empty a)", () => {
    expect(parseAdHocSlug("-vs-something")).toBeNull();
  });

  test("returns null when b is empty after delimiter", () => {
    expect(parseAdHocSlug("something-vs-")).toBeNull();
  });

  test("returns null when a and b are identical", () => {
    expect(parseAdHocSlug("ethereum-vs-ethereum")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseAdHocSlug("")).toBeNull();
  });
});

describe("canonicalisationTarget", () => {
  test("returns canonical (sorted) slug when out of order", () => {
    expect(canonicalisationTarget("solana-vs-ethereum")).toBe("ethereum-vs-solana");
  });

  test("returns null when slug is already canonical", () => {
    expect(canonicalisationTarget("ethereum-vs-solana")).toBeNull();
  });

  test("returns null for invalid pair slug", () => {
    expect(canonicalisationTarget("not-a-pair")).toBeNull();
  });

  test("returns null for same-provider slug", () => {
    expect(canonicalisationTarget("eth-vs-eth")).toBeNull();
  });

  test("alphabetical ordering determines canonical form", () => {
    expect(canonicalisationTarget("zcash-vs-aptos")).toBe("aptos-vs-zcash");
  });
});
