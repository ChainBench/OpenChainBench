import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The static hub block of the sitemap is a hand-maintained list, which is
 * exactly the kind of list that grows a duplicate. It has happened twice:
 * /chains/cosmos-hub shipped twice in the production sitemap on
 * 2026-09-30, and /contact was added twice while this file was being
 * written, because a grep for "/contact" does not match a template
 * literal spelled `${SITE.url}/contact`.
 *
 * A duplicate <loc> is not fatal, but it is a signal to a crawler that
 * something generates the file badly, and it inflates the URL count the
 * smoke test reads. Reading the source is enough to catch it: the
 * entries are literals.
 */
const SRC = readFileSync(path.join(process.cwd(), "src/lib/sitemap-builder.ts"), "utf8");

function staticRoutes(): string[] {
  // `${SITE.url}/some/path` inside the entry list
  return [...SRC.matchAll(/\$\{SITE\.url\}(\/[A-Za-z0-9/_-]*)`/g)].map((m) => m[1]);
}

describe("sitemap static routes", () => {
  test("the list is not empty, so the regex still matches the source", () => {
    expect(staticRoutes().length).toBeGreaterThan(10);
  });

  test("no route is listed twice", () => {
    const seen = new Map<string, number>();
    for (const r of staticRoutes()) seen.set(r, (seen.get(r) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([r, n]) => `${r} x${n}`);
    expect(dupes).toEqual([]);
  });

  test("/contact is listed", () => {
    expect(staticRoutes()).toContain("/contact");
  });
});
