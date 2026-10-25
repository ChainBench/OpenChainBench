import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { computeReadmeStats, parseBlock, renderBlock, syncReadme, START_MARKER, END_MARKER } from "./readme-stats";

// README.md's counts are generated (`pnpm readme:sync`). These tests read the
// repository only, never the network, so they pass or fail on the commit.

const root = path.resolve(import.meta.dir, "../..");
const readme = readFileSync(path.join(root, "README.md"), "utf8");
const stats = computeReadmeStats(root);
const STALE = "README.md's stats block no longer matches the repository. Run `pnpm readme:sync` and commit README.md.";

describe("README stats block", () => {
  test("is present", () => {
    expect(parseBlock(readme), `README.md has no "${START_MARKER}" ... "${END_MARKER}" block`).not.toBeNull();
  });

  test("matches the repository", () => {
    const current = parseBlock(readme)!;
    // Rendered with the block's own date: the date only moves when a count
    // does, so equality here means every count is current.
    expect(current.block, STALE).toBe(renderBlock(stats, current.date));
  });

  test("the reconciliation sentence is an identity, not just printed digits", () => {
    expect(stats.specs - stats.devOnlyWithSpec - stats.retiredWithSpec).toBe(stats.published);
  });

  test("published-by-category adds up to the published total", () => {
    expect(stats.publishedByCategory.reduce((n, [, c]) => n + c, 0)).toBe(stats.published);
  });

  test("every harness directory is a Go module, as the block says", () => {
    expect(stats.harnessesWithoutGoMod, "harnesses without go.mod: the block's label would be false").toEqual([]);
  });
});

describe("syncReadme", () => {
  const doc = (body: string) => `# Title\n\nintro\n\n${body}\n\n## After\n`;

  test("keeps the existing date when no count moved", () => {
    const before = doc(renderBlock(stats, "2026-01-01"));
    expect(syncReadme(before, stats, "2026-12-31")).toBe(before);
  });

  test("stamps today when a count moved, and leaves the rest of the file alone", () => {
    const moved = { ...stats, specs: stats.specs + 1, published: stats.published + 1 };
    const out = syncReadme(doc(renderBlock(stats, "2026-01-01")), moved, "2026-12-31");
    expect(out).toBe(doc(renderBlock(moved, "2026-12-31")));
  });

  test("refuses a README without markers instead of guessing where the block goes", () => {
    expect(() => syncReadme("# no block\n", stats, "2026-12-31")).toThrow();
  });
});
