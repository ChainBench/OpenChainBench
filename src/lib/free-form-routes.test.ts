import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A page route whose parameter is not checked against a closed set is an
 * unbounded set of indexable URLs.
 *
 * `/fee-compare/[venueA]/[venueB]/[wallet]` validated the venues against six
 * slugs and the wallet against `/^0x[0-9a-fA-F]{40}$/` only. Any address
 * passed, so every address times thirty ordered venue pairs returned 200 with
 * `index, follow` and a self canonical. Checked on production 2026-10-21:
 * `0x0000...dEaD` and `0x1111...1111` both served a 200 and both carried
 * `index, follow`.
 *
 * The crawl waste is the smaller half. /privacy says this site "measures
 * infrastructure, not people", and a wallet page is one person's trade
 * history. Every other page-level dynamic route was probed with unknown input
 * on the same day and all nine answered 404: products, benchmarks, chains,
 * compare, answers, perps/[asset], alternatives, and the two shallower
 * fee-compare segments. This was the only one.
 */
const APP = join(import.meta.dir, "..", "app");

/** Every page.tsx under a dynamic segment, as a route path. */
function dynamicPageRoutes(dir = APP, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry === "api") continue; // not indexable surfaces
    const childRel = `${rel}/${entry}`;
    if (readdirSync(full).includes("page.tsx") && childRel.includes("[")) {
      out.push(childRel);
    }
    out.push(...dynamicPageRoutes(full, childRel));
  }
  return out;
}

describe("a route that accepts any value is not indexable", () => {
  const WALLET_ROUTE = "/fee-compare/[venueA]/[venueB]/[wallet]";

  test("the wallet route declares noindex and canonicalises to the tool", () => {
    const src = readFileSync(join(APP, WALLET_ROUTE, "page.tsx"), "utf8");
    expect(src).toContain("robots: { index: false, follow: true }");
    // A self canonical on a noindex page asserts two things at once.
    expect(src).toContain("alternates: { canonical: `${SITE.url}/fee-compare` }");
  });

  test("its title carries no em dash", () => {
    // Site rule, and it was in the one place a title is built per request.
    const src = readFileSync(join(APP, WALLET_ROUTE, "page.tsx"), "utf8");
    const titleLine = src
      .split("\n")
      .find((l) => l.includes("title:") && l.includes("fees"));
    expect(titleLine).toBeDefined();
    expect(titleLine).not.toMatch(/[—–]/);
  });

  test("every other dynamic page route still validates against a closed set", () => {
    // The guard is not "declare noindex everywhere": benchmarks, products and
    // the rest are indexable on purpose and 404 on anything they do not know.
    // What this pins is that the inventory has not grown a second free-form
    // route without someone deciding what it does about indexing.
    const routes = dynamicPageRoutes().sort();
    expect(routes).toContain(WALLET_ROUTE);
    for (const route of routes) {
      if (route === WALLET_ROUTE) continue;
      const src = readFileSync(join(APP, route, "page.tsx"), "utf8");
      const closed =
        /notFound\(\)/.test(src) ||
        /robots:\s*\{\s*index:\s*false/.test(src) ||
        /generateStaticParams/.test(src);
      expect(
        closed,
        `${route} neither 404s on unknown input, pins static params, nor declares noindex`,
      ).toBe(true);
    }
  });
});
