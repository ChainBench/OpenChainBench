import { describe, expect, test } from "bun:test";
import { canonicalize } from "./providers";

// The 2026-09-22 SEO audit: /hyperliquid/tuleep 308s to /products/tuleep,
// which 404s, because the builder leaderboard publishes a short slug while
// the registry key carries the domain. "tuleep" is the largest single query
// on the property — 273 impressions at position 8.31 with zero clicks — and
// the page behind it did not exist.

describe("product slug aliases", () => {
  test("the leaderboard slugs resolve to their registry keys", () => {
    expect(canonicalize("tuleep").slug).toBe("tuleep-trade");
    expect(canonicalize("mass-money").slug).toBe("mass-dot-money");
  });

  test("a canonical slug resolves to itself", () => {
    expect(canonicalize("tuleep-trade").slug).toBe("tuleep-trade");
    expect(canonicalize("gram").slug).toBe("gram");
  });

  test("known rebrands still resolve", () => {
    expect(canonicalize("ton").slug).toBe("gram");
    expect(canonicalize("vertex").slug).toBe("nado");
  });

  test("case does not matter, the rewrites pass through whatever was linked", () => {
    expect(canonicalize("Tuleep").slug).toBe("tuleep-trade");
  });
});
