/**
 * Regenerate the counts block in README.md from the repository.
 *
 *   pnpm readme:sync            rewrite the block in place
 *   pnpm readme:sync --check    exit 1 if the block is stale, change nothing
 *
 * The logic lives in src/lib/readme-stats.ts so this script and
 * src/lib/readme-stats.test.ts cannot disagree.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeReadmeStats, syncReadme } from "../src/lib/readme-stats";

const root = path.resolve(__dirname, "..");
const readmePath = path.join(root, "README.md");
const readme = readFileSync(readmePath, "utf8");
const stats = computeReadmeStats(root);
const today = new Date().toISOString().slice(0, 10);
const next = syncReadme(readme, stats, today);

if (stats.harnessesWithoutGoMod.length) {
  console.error(`README says every harness is a Go module, but these have no go.mod: ${stats.harnessesWithoutGoMod.join(", ")}`);
  process.exit(1);
}
if (process.argv.includes("--check")) {
  if (next !== readme) {
    console.error("README stats block is stale. Run `pnpm readme:sync` and commit README.md.");
    process.exit(1);
  }
  console.log("README stats block is current.");
} else if (next === readme) {
  console.log("README stats block already current.");
} else {
  writeFileSync(readmePath, next);
  console.log(`README stats block updated: ${stats.specs} specs, ${stats.published} published.`);
}
