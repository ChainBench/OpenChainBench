#!/usr/bin/env node
/**
 * Generate `src/data/bench-published.json` — a static map of
 * { slug: ISO date } resolved from the first commit that added each
 * `benchmarks/<slug>.yml`.
 *
 * Why static: Vercel does a shallow `git clone --depth=1` so a runtime
 * `git log --diff-filter=A` returns nothing on the build container.
 * Generating the JSON locally (where git history is complete) and
 * committing it gives every bench a stable `datePublished` for Google,
 * with zero build-time dependency on git.
 *
 * Regenerate when adding a new bench:
 *   node scripts/generate-bench-published.mjs
 * Idempotent: running twice produces the same file, and an existing date is
 * never recomputed. See the comment above `previous` for why.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BENCH_DIR = path.join(ROOT, "benchmarks");
const OUT = path.join(ROOT, "src/data/bench-published.json");

const slugs = readdirSync(BENCH_DIR)
  .filter((f) => f.endsWith(".yml"))
  .map((f) => f.replace(/\.yml$/, ""))
  .sort();

// Read what is already published before computing anything.
//
// This script overwrote the file from scratch, and `--diff-filter=A` reports
// when the CURRENT path was added, which is not when the bench was published
// if the file has ever been renamed or re-added. The two together moved dates
// FORWARD on benches that have been live and indexed for months. It is not
// hypothetical: commit 873c8676 (2026-10-12) moved launchpad-wars from
// 2026-08-11 to 2026-10-07 and trading-platform-wars likewise, and that only
// stopped being live because f2fcc64e took main's copy of the file while
// catching dev up five days later. Nothing was fixed; the bug was buried.
//
// datePublished drives the citation date and the Dataset temporalCoverage on
// every live page, so moving one is an SEO change nobody asked for.
//
// Adding --follow was the obvious repair and it is worse. Tried on 2026-10-20:
// 52 entries moved EARLIER, about forty of them onto exactly 2026-07-24,
// because the RPC specs were created by copying an existing one and rename
// detection walks into the ancestor's history. That answers "when was the file
// this was copied from added", which would claim a bench was published before
// it existed.
//
// So the rule needs no history at all for a bench already in the file: the
// date was a fact at first publication and this file is the record. An
// existing entry is never recomputed; only a new slug is dated from the log.
// A date that genuinely needs correcting is edited here by hand, deliberately.
const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const map = { ...previous };
const kept = [];
for (const slug of slugs) {
  // An existing entry is never recomputed. This is the whole fix: the date is
  // a historical fact the file already records, and every way of asking the
  // repository for it again is wrong in one direction or the other.
  if (previous[slug]) {
    kept.push(slug);
    continue;
  }
  try {
    const out = execSync(
      `git log --diff-filter=A --format=%cI --reverse -- "benchmarks/${slug}.yml" | head -n 1`,
      { encoding: "utf8", cwd: ROOT, timeout: 5000 },
    ).trim();
    if (out) {
      const d = new Date(out);
      if (!Number.isNaN(d.getTime())) {
        map[slug] = d.toISOString();
        continue;
      }
    }
    // A spec that is written but not yet committed has no add-commit to
    // read. Skipping it leaves the slug out of the map, and every
    // datePublished, the citation date and the Dataset temporalCoverage
    // then fall back to the 2025-01-01 floor — which is how two live
    // benches ended up claiming twenty months of history they did not
    // have (SEO audit 2026-09-23). The file's own mtime is the honest
    // answer for a spec being added today.
    const mtime = statSync(path.join(ROOT, "benchmarks", `${slug}.yml`)).mtime;
    map[slug] = mtime.toISOString();
    console.warn(`[warn] ${slug} is not committed yet; using its mtime (${map[slug].slice(0, 10)})`);
  } catch (e) {
    console.warn(`[warn] git log failed for ${slug}: ${e.message}`);
  }
}

// Sorted, so a rerun cannot reorder the file and make a diff look like a change.
const sorted = Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]]));
writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n");
console.log(`wrote ${Object.keys(sorted).length} entries to ${path.relative(ROOT, OUT)}`);
if (kept.length > 0) {
  console.log(`kept ${kept.length} existing date(s) untouched`);
}
const dropped = Object.keys(previous).filter((k) => !(k in map));
if (dropped.length > 0) {
  console.log(
    `${dropped.length} slug(s) are in the file but have no spec any more, kept: ` +
      dropped.join(", "),
  );
}
