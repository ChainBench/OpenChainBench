import { describe, expect, test } from "bun:test";
import { config } from "./middleware";
import {
  REMOVED_ANSWER_SLUGS,
  REMOVED_BENCH_SLUGS,
  REMOVED_PRODUCT_SLUGS,
} from "@/lib/removed-benches";

// The middleware matcher must be a literal array (Next evaluates it at
// build time), so it cannot be derived from the slug sets at runtime.
// This test is the link between the two: it fails when a slug is added
// to (or removed from) a set without the matcher following.
const CASE_MATCHERS = [
  "/benchmarks/:slug([^/]*[A-Z][^/]*)",
  "/products/:slug([^/]*[A-Z][^/]*)",
  "/answers/:slug([^/]*[A-Z][^/]*)",
  "/compare/:slug([^/]*[A-Z][^/]*)",
  "/Benchmarks/:path*",
  "/Products/:path*",
  "/Answers/:path*",
  "/Compare/:path*",
];

describe("middleware matcher", () => {
  test("is the mixed-case rules plus exactly the set of retired URLs", () => {
    const expected = [
      ...CASE_MATCHERS,
      ...[...REMOVED_BENCH_SLUGS].map((s) => `/benchmarks/${s}`),
      ...[...REMOVED_ANSWER_SLUGS].map((s) => `/answers/${s}`),
      ...[...REMOVED_PRODUCT_SLUGS].map((s) => `/products/${s}`),
    ].sort();
    expect([...config.matcher].sort()).toEqual(expected);
  });

  test("every non-case entry is a literal path: live lowercase pages must not invoke the middleware", () => {
    for (const p of config.matcher) {
      if (CASE_MATCHERS.includes(p)) continue;
      expect(p).not.toMatch(/[:*()]/);
      expect(p).toBe(p.toLowerCase());
    }
  });

  test("the case regex admits only segments with an uppercase letter", () => {
    // Same regex Next compiles from the :slug(...) custom pattern
    // (verified against .next/server/middleware-manifest.json).
    const re = /^\/benchmarks\/([^/]*[A-Z][^/]*)$/;
    expect(re.test("/benchmarks/Perp-PE-Ratio")).toBe(true);
    expect(re.test("/benchmarks/perp-pe-ratio")).toBe(false);
    expect(re.test("/benchmarks/perp-pe-ratio/")).toBe(false);
  });
});
