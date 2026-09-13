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
describe("middleware matcher", () => {
  test("is exactly the set of retired URLs", () => {
    const expected = [
      ...[...REMOVED_BENCH_SLUGS].map((s) => `/benchmarks/${s}`),
      ...[...REMOVED_ANSWER_SLUGS].map((s) => `/answers/${s}`),
      ...[...REMOVED_PRODUCT_SLUGS].map((s) => `/products/${s}`),
    ].sort();
    expect([...config.matcher].sort()).toEqual(expected);
  });

  test("every entry is a literal path: live pages must not invoke the middleware", () => {
    // No regex or wildcard: Vercel evaluates matchers case-insensitively,
    // so even an "uppercase only" pattern would fire on every request.
    for (const p of config.matcher) {
      expect(p).not.toMatch(/[:*()]/);
      expect(p).toBe(p.toLowerCase());
    }
  });
});
