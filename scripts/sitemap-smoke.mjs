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
 */

const base = process.argv[2];
if (!base) {
  console.error("Usage: node scripts/sitemap-smoke.mjs <base-url>");
  process.exit(2);
}

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
async function getTextWithRetry(url, attempts = 3, timeoutMs = 60000) {
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

// Rewrite each URL's host to match the target base, so a smoke test
// against a Vercel preview URL still exercises the right deployment
// rather than hitting prod.
const targetHost = new URL(base).origin;
const urls = locs.map((u) => {
  try {
    const parsed = new URL(u);
    return `${targetHost}${parsed.pathname}${parsed.search}`;
  } catch {
    return u;
  }
});

const skipped = SKIP_REGEX ? urls.filter((u) => SKIP_REGEX.test(u)) : [];
const checkUrls = SKIP_REGEX ? urls.filter((u) => !SKIP_REGEX.test(u)) : urls;
console.log(
  `[smoke] sitemap has ${urls.length} URLs, checking ${checkUrls.length}` +
    (skipped.length > 0 ? ` (skipped ${skipped.length})` : ""),
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
