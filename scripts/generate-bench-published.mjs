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
 * Idempotent — running twice produces the same file.
 */

import { execSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BENCH_DIR = path.join(ROOT, "benchmarks");
const OUT = path.join(ROOT, "src/data/bench-published.json");

const slugs = readdirSync(BENCH_DIR)
  .filter((f) => f.endsWith(".yml"))
  .map((f) => f.replace(/\.yml$/, ""))
  .sort();

const map = {};
for (const slug of slugs) {
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
    console.warn(`[warn] no git log for ${slug}, skipping`);
  } catch (e) {
    console.warn(`[warn] git log failed for ${slug}: ${e.message}`);
  }
}

writeFileSync(OUT, JSON.stringify(map, null, 2) + "\n");
console.log(`wrote ${Object.keys(map).length} entries to ${path.relative(ROOT, OUT)}`);
