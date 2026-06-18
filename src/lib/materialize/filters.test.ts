/**
 * filterSig is THE cache key for every materialized variant. A sig that
 * isn't stable across reorderings (or that leaks "all" sentinels) would
 * desync the worker's writes from the site's reads, leaving a stale or
 * empty page. These tests pin the canonical encoding.
 */
import { describe, expect, test } from "bun:test";
import {
  activeFilterLabels,
  filterSig,
  parseFilterSig,
} from "./filters";

describe("filterSig", () => {
  test("encodes a single dimension", () => {
    expect(filterSig({ chain: "ethereum" })).toBe("chain=ethereum");
  });

  test("emits keys in alphabetical order regardless of input order", () => {
    expect(filterSig({ region: "us-east", chain: "ethereum" })).toBe(
      "chain=ethereum&region=us-east",
    );
    expect(filterSig({ chain: "ethereum", region: "us-east" })).toBe(
      "chain=ethereum&region=us-east",
    );
  });

  test("treats 'all' and undefined as no-filter", () => {
    expect(filterSig({ chain: "all" })).toBe("");
    expect(filterSig({ chain: undefined })).toBe("");
    expect(filterSig({})).toBe("");
  });
});

describe("parseFilterSig", () => {
  test("round-trips a single dimension", () => {
    const f = { chain: "ethereum" };
    expect(parseFilterSig(filterSig(f))).toEqual(f);
  });

  test("round-trips a multi-dimension sig", () => {
    const f = { chain: "ethereum", region: "us-east" };
    expect(parseFilterSig(filterSig(f))).toEqual(f);
  });

  test("empty sig parses to empty object", () => {
    expect(parseFilterSig("")).toEqual({});
  });

  test("ignores unknown keys (defensive against URL tampering)", () => {
    expect(parseFilterSig("chain=eth&unknown=foo")).toEqual({ chain: "eth" });
  });
});

describe("activeFilterLabels", () => {
  test("drops undefined and 'all' values", () => {
    expect(
      activeFilterLabels({ chain: "ethereum", region: "all" }),
    ).toEqual({ chain: "ethereum" });
    expect(activeFilterLabels({})).toEqual({});
  });

  test("keeps every present non-'all' label", () => {
    expect(
      activeFilterLabels({ chain: "base", region: "us-east", kind: "swap" }),
    ).toEqual({ chain: "base", region: "us-east", kind: "swap" });
  });
});
