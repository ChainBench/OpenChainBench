#!/usr/bin/env node
/**
 * Sitemap indexability smoke test.
 *
 * Fetches /sitemap.xml from the target host, then for each URL checks:
 *   - HTTP status is 200 (no 4xx, no 5xx, no redirect chain that lands
 *     off-host)
 *   - HTML head has no `<meta name="robots" content="...noindex...">`
 *   - HTTP headers have no `X-Robots-Tag: ...noindex...`
 *
 * Exits 0 when every URL passes, exits 1 with a per-URL log otherwise.
 *
 * Used in the prod-deploy workflow as the last step before declaring a
 * deploy successful. Catches the class of regression that bled SEO on
 * 2026-06-25 (a bench page returning 404 + noindex while still listed
 * in the sitemap) before the next crawl cycle hits it.
 *
 * Usage:
 *   node scripts/sitemap-smoke.mjs https://openchainbench.com
 *
 * Env knobs:
 *   SMOKE_CONCURRENCY  parallel requests (default 8)
 *   SMOKE_TIMEOUT_MS   per-request timeout (default 20000)
 *   SMOKE_SKIP_REGEX   skip URLs matching this regex (default none)
 *   SMOKE_SAMPLE       check hubs + touched pages + this many tail pages
 *                      (default 0 = check everything, as before)
 *   SMOKE_SEED         rotates which tail slice a run picks
 *   SMOKE_ALWAYS_REGEX URLs to always check on top of the hubs
 */

const base = process.argv[2];
if (!base) {
  console.error("Usage: node scripts/sitemap-smoke.mjs <base-url> [check-host]");
  process.exit(2);
}

// Optional second arg: host to check individual page URLs against.
// When base is a Vercel preview URL (which injects noindex on every page
// by design), pass the prod domain here so page checks run against the
// real indexed host while the sitemap is still fetched fresh from base.
const checkHost = process.argv[3] ? new URL(process.argv[3]).origin : null;

const CONCURRENCY = Number(process.env.SMOKE_CONCURRENCY ?? 8);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 20000);
const SKIP_REGEX = process.env.SMOKE_SKIP_REGEX
  ? new RegExp(process.env.SMOKE_SKIP_REGEX)
  : null;

const sitemapUrl = `${base.replace(/\/$/, "")}/sitemap.xml`;
console.log(`[smoke] fetching ${sitemapUrl}`);

async function getText(url, timeoutMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "manual" });
    const text = await res.text().catch(() => "");
    return { res, text };
  } finally {
    clearTimeout(t);
  }
}

// The first sitemap render after a fresh deploy is cold (full catalog
// load) and can exceed a single request timeout. Retry with backoff so
// a cold cache never fails the smoke and triggers a rollback of a
// perfectly healthy deploy (observed 2026-07-10: AbortError at 20s,
// sitemap healthy 30s later).
async function getTextWithRetry(url, attempts = 3, timeoutMs = 90000) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await getText(url, timeoutMs);
    } catch (err) {
      lastErr = err;
      console.warn(`[smoke] attempt ${i}/${attempts} failed: ${err}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 10000 * i));
    }
  }
  throw lastErr;
}

const sitemapRes = await getTextWithRetry(sitemapUrl);
if (sitemapRes.res.status !== 200) {
  console.error(
    `[smoke] sitemap fetch failed: status=${sitemapRes.res.status}`,
  );
  process.exit(1);
}

// Crude XML parse, no dep. Sitemap shape is `<urlset><url><loc>URL</loc>…`
const locs = Array.from(sitemapRes.text.matchAll(/<loc>([^<]+)<\/loc>/g)).map(
  (m) => m[1].trim(),
);
if (locs.length === 0) {
  console.error("[smoke] sitemap parsed to zero URLs");
  process.exit(1);
}

// Rewrite each URL's host: use checkHost when provided (prod domain so
// preview-URL noindex doesn't false-fail), otherwise same host as base.
const targetHost = checkHost ?? new URL(base).origin;
if (checkHost) {
  console.log(`[smoke] checking pages against ${targetHost}`);
}
const urls = locs.map((u) => {
  try {
    const parsed = new URL(u);
    return `${targetHost}${parsed.pathname}${parsed.search}`;
  } catch {
    return u;
  }
});

const skipped = SKIP_REGEX ? urls.filter((u) => SKIP_REGEX.test(u)) : [];
const eligible = SKIP_REGEX ? urls.filter((u) => !SKIP_REGEX.test(u)) : urls;

// Stratified selection, off by default.
//
// Checking all 1,211 sitemap URLs on every production deploy was the
// single largest line of runtime cost we could attribute: six deploys in
// the two days to 2026-09-30 rendered about 7,266 pages here, roughly 63%
// of all cold renders in the window, and the two largest lines on the
// Vercel bill were the function memory and CPU those renders consumed.
//
// The gate itself is not negotiable: it exists because on 2026-06-25 a
// bench page went 404 with a noindex while still listed in the sitemap,
// and nobody noticed until the crawl. So instead of checking less
// carefully, it checks the same way over a smaller, deliberately chosen
// set.
//
//   always      every hub and top-level page (path depth 0 or 1). These
//               carry the traffic and the internal links, and a
//               regression here is the expensive kind.
//   always      anything the deploy actually touched, passed in as
//               SMOKE_ALWAYS_REGEX by the workflow from the diff. New
//               and edited pages are where regressions come from.
//   sampled     the long tail of detail pages, SMOKE_SAMPLE of them,
//               rotated by SMOKE_SEED so consecutive deploys cover
//               different slices and the whole catalogue is covered
//               across a handful of deploys.
//
// What this costs: a broken detail page can survive one deploy before it
// is seen, instead of being caught within minutes. What it does not cost
// is coverage over time, or any weakening of the per-URL check.
//
// Leave SMOKE_SAMPLE unset and the behaviour is exactly as before: every
// eligible URL is checked. A manual run gets the full sweep.
const SAMPLE = Number(process.env.SMOKE_SAMPLE ?? 0);
const SEED = Number(process.env.SMOKE_SEED ?? 0);
const ALWAYS_REGEX = process.env.SMOKE_ALWAYS_REGEX
  ? new RegExp(process.env.SMOKE_ALWAYS_REGEX)
  : null;

function depth(u) {
  try {
    return new URL(u).pathname.replace(/^\/|\/$/g, "").split("/").filter(Boolean).length;
  } catch {
    return 99;
  }
}

let checkUrls = eligible;
let sampleNote = "";
if (SAMPLE > 0) {
  const always = eligible.filter((u) => depth(u) <= 1 || (ALWAYS_REGEX && ALWAYS_REGEX.test(u)));
  const alwaysSet = new Set(always);
  const tail = eligible.filter((u) => !alwaysSet.has(u)).sort();
  let picked = tail;
  if (tail.length > SAMPLE) {
    // Rotate the window by the seed so the slice moves deploy to deploy
    // and the tail is covered in full every ceil(tail / SAMPLE) deploys.
    const windows = Math.ceil(tail.length / SAMPLE);
    const start = ((SEED % windows) + windows) % windows * SAMPLE;
    picked = tail.slice(start, start + SAMPLE);
    if (picked.length < SAMPLE) picked = picked.concat(tail.slice(0, SAMPLE - picked.length));
  }
  checkUrls = always.concat(picked);
  sampleNote =
    `, stratified: ${always.length} always + ${picked.length} of ${tail.length} sampled` +
    ` (seed ${SEED}, covers the tail every ${Math.max(1, Math.ceil(tail.length / SAMPLE))} deploys)`;
}

console.log(
  `[smoke] sitemap has ${urls.length} URLs, checking ${checkUrls.length}` +
    (skipped.length > 0 ? ` (skipped ${skipped.length})` : "") +
    sampleNote,
);

async function checkOne(url) {
  try {
    const { res, text } = await getText(url);
    const issues = [];
    if (res.status !== 200) {
      issues.push(`status=${res.status}`);
    } else {
      const xRobots = (res.headers.get("x-robots-tag") || "").toLowerCase();
      if (xRobots.includes("noindex"))
        issues.push(`x-robots-tag noindex (${xRobots})`);
      const metaMatch = text.match(
        /<meta[^>]*name=["']robots["'][^>]*content=["']([^"']+)["']/i,
      );
      const metaRobots = metaMatch?.[1]?.toLowerCase() ?? "";
      if (metaRobots.includes("noindex"))
        issues.push(`meta robots noindex (${metaRobots})`);
    }
    return { url, ok: issues.length === 0, issues };
  } catch (err) {
    return { url, ok: false, issues: [`fetch_error: ${err.message || err}`] };
  }
}

const results = [];
const queue = checkUrls.slice();
async function worker() {
  while (queue.length > 0) {
    const url = queue.shift();
    const r = await checkOne(url);
    results.push(r);
    if (r.ok) console.log(`✓ ${url}`);
    else console.error(`✗ ${url} → ${r.issues.join(", ")}`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const failed = results.filter((r) => !r.ok);
console.log(
  `\n[smoke] ${results.length - failed.length}/${results.length} OK, ${failed.length} failed`,
);

if (failed.length > 0) {
  console.error("\n[smoke] FAILURES (deploy will be blocked):");
  for (const f of failed) console.error(`  ${f.url} → ${f.issues.join(", ")}`);
  process.exit(1);
}

console.log("[smoke] all URLs are indexable.");
process.exit(0);
