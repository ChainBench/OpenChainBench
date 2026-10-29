import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A bench gaining a provider needs the cache keys to move, and remembering is
 * not working.
 *
 * spec.ts already says it, in the note on bench-unfiltered-v93: "A cached
 * entry holds the provider set current when it was written, so a bench gaining
 * a row needs the key to move or the row never appears." It was written on
 * 2026-10-21 after Nova's row stayed invisible for seven minutes of polling
 * and a field-by-field diff of the blob.
 *
 * Two PRs later it happened again, twice over. Pump Bridge (#3188) and
 * FOMO · Mobula (#3226) joined bench 268 and neither moved a key. Both were
 * live in the materialized blob, pump-bridge at p50 269.6 over 939 swaps and
 * fomo-mobula at 297.2 over 2,512, and the board showed 14 rows with ALL
 * selected while the blob held 16 ranked. The note did not prevent the thing
 * the note describes.
 *
 * So the invariant is a test. It hashes every bench's provider set and fails
 * when that hash moves without this file being updated, which cannot happen
 * without the author reading the message below and deciding about the keys.
 *
 * The same shape as the poller test in the harness: the failure is an
 * ABSENCE, a bump that did not happen, and nothing observable at runtime
 * reports it. The page simply renders a row short, which looks like the
 * harness not having data rather than the site not asking for it.
 */
const BENCH_DIR = join(import.meta.dir, "..", "..", "benchmarks");

/** slug -> its provider slugs, read from the YAML without a parser so this
 *  test cannot be broken by a schema change it is not about. */
function providerSets(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(BENCH_DIR).filter((f) => f.endsWith(".yml")).sort()) {
    const src = readFileSync(join(BENCH_DIR, f), "utf8");
    // Providers are the "  - slug: x" entries under `providers:`; the bench's
    // own top-level `slug:` has no leading dash and is not matched.
    const slugs = [...src.matchAll(/^\s+-\s+slug:\s*([A-Za-z0-9._-]+)\s*$/gm)]
      .map((m) => m[1])
      .sort();
    if (slugs.length) out.push(`${f}:${slugs.join(",")}`);
  }
  return out;
}

describe("the provider set behind the cache keys", () => {
  test("has not changed without someone deciding about the cache keys", () => {
    const sets = providerSets();
    const hash = createHash("sha256").update(sets.join("\n")).digest("hex").slice(0, 16);
    const count = sets.reduce((n, s) => n + s.split(":")[1].split(",").length, 0);

    // Re-recorded on 2026-10-29 with bench-unfiltered-v118,
    // all-benchmarks-v111, bench-filters-v56, providers-v31.
    //
    // The change is an ADDITION, bench 311 rpc-api-coverage. All four keys
    // moved: it declares a chain dimension, so bench-filters is not optional,
    // and its six providers gain an appearance in the RPCs category, so
    // providers-v moves too or /products, compare and answers keep listing
    // them one bench short.
    expect(
      hash,
      [
        "A bench's provider set changed, which means a cached entry written",
        "before your change holds the OLD set and the new row will never",
        "appear on the page however good the data is.",
        "",
        "Before updating the hash below, move the keys in src/lib/spec.ts:",
        "  bench-unfiltered-vN   always",
        "  all-benchmarks-vM     always, and its lockstep note names the new N",
        "  bench-filters-vK      if the bench declares dimensions, or the row",
        "                        is invisible on every tab but the default",
        "  providers-vP          in src/lib/providers.ts, or /products,",
        "                        compare and answers keep the old appearances",
        "",
        "Then set EXPECTED to the hash in this failure, and add the provider",
        `to PRODUCT_NAMES if it needs a display name. Providers now: ${count}.`,
      ].join("\n"),
    ).toBe("9abf98f80d8d255e");
  });
});
