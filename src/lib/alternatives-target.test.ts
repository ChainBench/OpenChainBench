import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

/**
 * An alternatives page ranks the field on one benchmark. If the product the
 * page is about is not a row in that benchmark, the reader gets a table their
 * starting point is absent from and cannot compare.
 *
 * Measured on 2026-10-21 across all 24 pages: nine declare a benchmark that
 * does not measure their own subject. /alternatives/alchemy ranks on
 * aggregator-head-lag, which measures how fast a price API publishes and
 * carries no Alchemy row; Alchemy is measured on the RPC benches instead. Five
 * of the nine name a product measured on no bench at all, so they cannot be
 * repointed and need an editorial decision rather than a fix.
 *
 * This test does not demand the nine be fixed. It pins the list, so the page
 * template keeps telling the reader when its subject is absent, and so a tenth
 * cannot be added without someone seeing this file.
 */
const ROOT = join(import.meta.dir, "..", "..");
const ALT = join(ROOT, "alternatives");
const BENCH = join(ROOT, "benchmarks");

type Alt = { slug: string; target_product: string; benchmark?: string };

function benchHasRow(benchSlug: string, slug: string): boolean | null {
  const p = join(BENCH, `${benchSlug}.yml`);
  try {
    const src = readFileSync(p, "utf8");
    return new RegExp(`^\\s*-\\s*slug:\\s*${slug}\\s*$`, "m").test(src);
  } catch {
    return null; // the bench does not exist
  }
}

const alts: Alt[] = readdirSync(ALT)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((f) => yaml.load(readFileSync(join(ALT, f), "utf8")) as Alt);

/** The pages whose declared benchmark does not carry their own subject.
 *  Shrink this list by repointing or by measuring the product; never grow it
 *  without reading the comment above. */
const TARGET_ABSENT = new Set([
  "alchemy",
  "birdeye",
  "bitquery",
  "chainlink",
  "dune",
  "jupiter",
  "pump-portal",
  "pyth",
  "quicknode",
  "the-graph",
]);

describe("an alternatives page ranks a field its subject belongs to", () => {
  test("the known-absent list matches reality, in both directions", () => {
    const absent: string[] = [];
    for (const a of alts) {
      if (!a.benchmark) continue;
      if (benchHasRow(a.benchmark, a.slug) !== true) absent.push(a.slug);
    }
    // Both directions: a page that quietly joins the list fails, and a page
    // repointed correctly fails until it is taken off the list, so the list
    // cannot rot into a blanket exemption.
    expect(absent.sort()).toEqual([...TARGET_ABSENT].sort());
  });

  test("the template tells the reader when its subject is absent", () => {
    const page = readFileSync(
      join(ROOT, "src", "app", "alternatives", "[slug]", "page.tsx"),
      "utf8",
    );
    expect(page).toContain("const targetInBench = bench.results.some(");
    expect(page).toContain("is not measured on this benchmark");
  });

  test("every page names a benchmark at all", () => {
    const none = alts.filter((a) => !a.benchmark).map((a) => a.slug);
    expect(none).toEqual([]);
  });

  test("no page points at a benchmark that does not exist", () => {
    // /alternatives/jupiter declares solana-dex-quote-latency, which was
    // dropped from the site and answers 410. The page itself already 404s, so
    // this is dead weight rather than a live defect, and it is the one entry
    // here that is a dangling reference rather than a mismatch.
    const dangling = alts
      .filter((a) => a.benchmark && benchHasRow(a.benchmark, a.slug) === null)
      .map((a) => `${a.slug} -> ${a.benchmark}`);
    expect(dangling).toEqual(["jupiter -> solana-dex-quote-latency"]);
  });
});
