#!/usr/bin/env tsx
/**
 * Emit `data/page-mtimes.json`, a static map of
 *   { "<rel-path-under-src/app>": <git-log %ct seconds> }
 * for the editorial hub pages whose freshness feeds the sitemap.
 *
 * Vercel's build container runs a shallow `git clone` and, worse,
 * resets every checked-out file's mtime to the build-system default
 * (Oct 20 2018). Both make a runtime `statSync` useless for a real
 * <lastmod>, and a runtime `git log` returns nothing.
 *
 * The fix: run this script in `prebuild` (executed BEFORE `next build`,
 * on the deploy machine where `.git/` is complete), resolve each page's
 * last commit timestamp via `git log -1 --format=%ct`, and write the
 * result to a JSON manifest. `src/app/sitemap.ts` reads the manifest at
 * module scope and returns the timestamp per URL.
 *
 * Fallback chain (per page):
 *   1. `git log -1 --format=%ct -- <rel>`
 *   2. `statSync(<rel>).mtime` (Unix seconds)
 *   3. process.env.NEXT_PUBLIC_BUILD_TIME (Unix seconds)
 *
 * Regenerated on every build. Do NOT commit `data/page-mtimes.json`.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const APP_DIR = path.join(ROOT, "src/app");
const OUT_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(OUT_DIR, "page-mtimes.json");

// Pages the sitemap consults via pageMtime(). Keep this list in sync
// with staticHubRoutes in src/app/sitemap.ts. Ordered by ship date so
// diffs read cleanly when a new hub is added.
const PAGES: string[] = [
  "mcp/page.tsx",
  "methodology/page.tsx",
  "contribute/page.tsx",
  "partners/page.tsx",
  "about/page.tsx",
  "press/page.tsx",
  "compare/page.tsx",
  "alternatives/page.tsx",
  "team/page.tsx",
];

function gitMtimeSeconds(rel: string): number | null {
  try {
    const abs = path.join("src/app", rel);
    const out = execSync(`git log -1 --format=%ct -- "${abs}"`, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    const secs = Number.parseInt(out, 10);
    if (!Number.isFinite(secs) || secs <= 0) return null;
    return secs;
  } catch {
    return null;
  }
}

function statMtimeSeconds(rel: string): number | null {
  try {
    const abs = path.join(APP_DIR, rel);
    if (!existsSync(abs)) return null;
    const s = statSync(abs);
    const secs = Math.floor(s.mtimeMs / 1000);
    if (!Number.isFinite(secs) || secs <= 0) return null;
    return secs;
  } catch {
    return null;
  }
}

function buildTimeSeconds(): number {
  const raw = process.env.NEXT_PUBLIC_BUILD_TIME;
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return Math.floor(t / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function main(): void {
  const manifest: Record<string, number> = {};
  const buildFallback = buildTimeSeconds();
  for (const rel of PAGES) {
    const git = gitMtimeSeconds(rel);
    if (git !== null) {
      manifest[rel] = git;
      continue;
    }
    const stat = statMtimeSeconds(rel);
    if (stat !== null) {
      manifest[rel] = stat;
      continue;
    }
    manifest[rel] = buildFallback;
  }
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  const rel = path.relative(ROOT, OUT_FILE);
  console.log(`wrote ${Object.keys(manifest).length} entries to ${rel}`);
}

main();
