import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getBenchmarks } from "@/data/benchmarks";
import { getProvider, getProviders, getProviderSlugs } from "@/lib/providers";
import { loadAllAlternatives } from "@/lib/alternatives";
import { loadAllAnswers } from "@/lib/answers";
import { adHocPairs } from "@/lib/compare/adhoc-pairs";
import { COMPARE_PAIRS } from "@/data/compare-pairs";
import { CATEGORIES } from "@/lib/categories";
import { CHAIN_BY_SLUG, CHAINS, getBenchmarksForChain } from "@/lib/chains";
import { canonicalChainSlug } from "@/lib/chain-aliases";
import { isHlBuilderSlug } from "@/lib/hl-builder-stats";
import { REMOVED_BENCH_SLUGS } from "@/lib/removed-benches";
import { SITE } from "@/data/site";
import { pingIndexNow } from "@/lib/indexnow";
import {
  readCohortSnapshot,
  writeCohortSnapshot,
} from "@/lib/cohort-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The map now fans out getProvider over every catalog slug plus
// getBenchmarksForChain per chain (same shape of work the sitemap does).
// Cold cache runs need head room above the 60 s function default.
export const maxDuration = 300;

/**
 * Hourly IndexNow ping, diff-based ("streaming" mode).
 *
 * Bing Webmaster Tools flags whole-site daily submissions as "IndexNow is
 * in batch mode": submitting every URL regardless of change wastes crawl
 * budget and dilutes the freshness signal. This route instead keeps a
 * url → fingerprint map in KV and submits ONLY urls whose fingerprint
 * changed since the previous run, plus urls that appeared or disappeared
 * (the IndexNow spec asks for deleted urls too, so engines recrawl and
 * observe the 410/redirect).
 *
 * Fingerprint inputs per URL family (must mirror src/app/sitemap.ts —
 * every family the sitemap emits is tracked here, with the same
 * prod-gate exclusions, so IndexNow never advertises a URL the sitemap
 * would hide and never misses one it publishes):
 *   - Bench pages: leader provider slug + rounded leader value + seoTitle
 *     ("the page's headline claim changed").
 *   - Per-chain bench sub-pages (/benchmarks/<slug>/<chain>): the parent
 *     bench's headline fingerprint. Resubmitted when the parent claim
 *     moves, not on every scrape.
 *   - Product / alternative pages: membership only (they change rarely;
 *     add/remove is the signal).
 *   - Compare pairs and answers: family membership hash. Every member
 *     carries the hash of the sorted member list, so a new page is
 *     submitted once (map diff: added) and the family is resubmitted
 *     when the set changes (internal link lists on the sibling pages
 *     changed too). Deliberately does NOT include the catalog lastRunAt
 *     timestamp: that moves every scrape and would resubmit ~250 URLs
 *     hourly, which is the batch-mode pattern this route avoids.
 *   - Chain hubs (/chains/<slug>): hash of the sorted bench slugs
 *     covering the chain (the page is a list of those benches).
 *   - Category hubs (/benchmarks/category/<slug>): hash of the sorted
 *     bench slugs in the category.
 *   - Static hubs: NEXT_PUBLIC_BUILD_TIME, so they are re-submitted once
 *     per deploy.
 *
 * Wiring (operator):
 *   1. Generate a 32-char hex key (`openssl rand -hex 16`).
 *   2. Put it in `public/<key>.txt` (content = the key itself) and
 *      `INDEXNOW_KEY` Vercel env var.
 *   3. `CRON_SECRET` Vercel env var gates this route.
 *   4. vercel.json crons block calls this route once an hour.
 *
 * Manual test:
 *   curl https://openchainbench.com/api/cron/indexnow \
 *        -H "Authorization: Bearer ${CRON_SECRET}"
 *
 * Returns `{ok, submitted, batches, message, tracked, changed, added,
 * removed, firstRun}`. When INDEXNOW_KEY is absent the ping is a no-op
 * (dry-mode) and the fingerprint map is NOT persisted, so the first run
 * with the key configured retries the same diff.
 */

/** KV key for the url → fingerprint map (via cohort-snapshot helpers,
 *  final Upstash key: `ocb:cohort:indexnow-fingerprints:v1`). */
const FINGERPRINT_KEY = "indexnow-fingerprints";

/** The cohort-snapshot reader defaults to a 10-minute staleness ceiling
 *  (tuned for live-metric blobs). Our map is state, not a cache: accept
 *  it up to the blob's own 24h TTL. If the blob does expire (cron dead
 *  for a day), the route degrades to first-run behavior below. */
const FINGERPRINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type FingerprintMap = Record<string, string>;

/** FNV-1a 32-bit, hex-encoded. Not cryptographic — just a short stable
 *  digest so the KV map stays a few KB regardless of input length. */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function isAuthorized(req: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  const header = (req.headers.get("authorization") ?? "").trim();
  if (!secret) {
    // Fail closed in production; permissive in dev for local testing.
    return process.env.NODE_ENV !== "production";
  }
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/** Family membership hash: same value stamped on every member URL of a
 *  set-shaped family (compare pairs, answers). See the header comment
 *  for why this deliberately excludes the catalog timestamp. */
function setFingerprint(members: string[]): string {
  return shortHash([...members].sort().join("\n"));
}

async function buildFingerprintMap(
  prev: FingerprintMap,
): Promise<FingerprintMap> {
  const [benches, alternatives, answers, providerSlugs, profiles] =
    await Promise.all([
      getBenchmarks(),
      loadAllAlternatives(),
      loadAllAnswers(),
      getProviderSlugs(),
      getProviders(),
    ]);

  const map: FingerprintMap = {};

  // Static hubs: fingerprinted on the deploy timestamp so each deploy
  // re-submits them exactly once. Mirrors staticHubRoutes() in sitemap.ts.
  const deployFp = shortHash(process.env.NEXT_PUBLIC_BUILD_TIME ?? "static");
  const hubs = [
    "",
    "/benchmarks",
    "/products",
    "/methodology",
    "/about",
    "/mcp",
    "/rpc",
    "/prediction-markets",
    "/hyperliquid",
    "/perps",
    "/chains",
    "/contribute",
    "/partners",
    "/badges",
    "/press",
    "/compare",
    "/alternatives",
    "/answers",
  ];
  for (const path of hubs) {
    map[`${SITE.url}${path}`] = deployFp;
  }

  // Bench pages: fingerprint = the headline claim (leader slug + rounded
  // leader p50 + seoTitle). Rounding to 0.1 units keeps sub-noise metric
  // wobble from triggering a resubmission every hour.
  //
  // REMOVED_BENCH_SLUGS is the same prod gate the sitemap applies: those
  // slugs 410 on production, so submitting them would ask engines to
  // crawl gated pages. The loader already drops them on prod, the
  // explicit filter keeps staging/dev runs honest too.
  // All non-gated benches, used for the "parent bench must exist" rule
  // on alternatives / answers / categories (mirrors sitemap.ts, which
  // keys those checks on the full loaded catalog, not editorial status).
  const publishedBenches = benches.filter(
    (b) => !REMOVED_BENCH_SLUGS.has(b.slug),
  );
  const publishedSlugs = new Set(publishedBenches.map((b) => b.slug));

  for (const b of publishedBenches) {
    if (b.editorialStatus !== "live") continue;
    const leader = b.results[0];
    const fp = leader
      ? `${leader.slug}:${Math.round(leader.ms.p50 * 10)}:${b.seoTitle ?? ""}`
      : `no-leader:${b.seoTitle ?? ""}`;
    const benchFp = shortHash(fp);
    map[`${SITE.url}/benchmarks/${b.slug}`] = benchFp;

    // Per-chain sub-pages. Same enumeration as sitemap.ts: a
    // perChainExplainer entry only yields a live URL when its canonical
    // slug also appears in the bench's results or chain dimension.
    // Fingerprint = the parent bench's headline fingerprint, so the
    // sub-pages resubmit when the parent claim changes, not hourly.
    const resultSlugs = new Set(
      b.results.map((r) => canonicalChainSlug(r.slug)),
    );
    const chainValues = new Set(
      (b.dimensions?.chain ?? [])
        .filter((c) => c.value.toLowerCase() !== "all")
        .map((c) => canonicalChainSlug(c.value)),
    );
    for (const e of b.perChainExplainer ?? []) {
      const canon = canonicalChainSlug(e.slug);
      if (!resultSlugs.has(canon) && !chainValues.has(canon)) continue;
      map[`${SITE.url}/benchmarks/${b.slug}/${canon}`] = benchFp;
    }
  }

  // Product pages: validate each slug the same way the sitemap does so
  // we never submit a /products/<slug> that 404s (unknown provider),
  // 308s (chain slug moved to /chains) or 307s (HL builder frontend).
  await isHlBuilderSlug("").catch(() => false);
  const validatedSlugs = (
    await Promise.all(
      providerSlugs.map(async (slug) => {
        if (CHAIN_BY_SLUG.has(slug)) return null;
        if (await isHlBuilderSlug(slug)) return null;
        const p = await getProvider(slug);
        return p ? slug : null;
      }),
    )
  ).filter((s): s is string => s !== null);

  // Product / alternative pages change rarely; membership add/remove is
  // the signal, so a constant fingerprint suffices.
  for (const slug of validatedSlugs) {
    map[`${SITE.url}/products/${slug}`] = "exists";
  }
  for (const alt of alternatives) {
    if (!publishedSlugs.has(alt.benchmark)) continue;
    map[`${SITE.url}/alternatives/${alt.slug}`] = "exists";
  }

  // Answers: loadAllAnswers already applies the prod gate
  // (REMOVED_ANSWER_SLUGS + removed parent benches on production); the
  // publishedSlugs filter mirrors the sitemap's "parent bench must
  // exist" rule. Family membership hash: see header comment.
  const answerSlugs = answers
    .filter((a) => publishedSlugs.has(a.benchmark))
    .map((a) => a.slug);
  const answersFp = setFingerprint(answerSlugs);
  for (const slug of answerSlugs) {
    map[`${SITE.url}/answers/${slug}`] = answersFp;
  }

  // Chain hubs: only chains whose page actually renders (the page 404s
  // when getBenchmarksForChain returns []), same rule as the sitemap.
  // Fingerprint = the sorted bench slugs covering the chain, so the hub
  // resubmits when a bench enters or leaves its coverage.
  await Promise.all(
    CHAINS.map(async (c) => {
      try {
        const covering = await getBenchmarksForChain(c.slug);
        if (covering.length === 0) return;
        map[`${SITE.url}/chains/${c.slug}`] = setFingerprint(
          covering.map((b) => b.slug),
        );
      } catch {
        // Transient loader failure: carry the previous fingerprint over
        // (when we have one) so the URL is neither resubmitted as
        // changed nor advertised as removed. Mirrors the sitemap's
        // "a Prom outage should not disappear known-good chain hubs".
        const url = `${SITE.url}/chains/${c.slug}`;
        if (prev[url]) map[url] = prev[url];
      }
    }),
  );

  // Category hubs: closed enum, page 404s on empty categories. Same
  // filter as the sitemap (match on display label).
  for (const c of CATEGORIES) {
    const catBenches = publishedBenches.filter(
      (b) => b.category === c.label,
    );
    if (catBenches.length === 0) continue;
    map[`${SITE.url}/benchmarks/category/${c.slug}`] = setFingerprint(
      catBenches.map((b) => b.slug),
    );
  }

  // Compare pairs: curated pairs (provider-validated, like the sitemap)
  // plus the shared ad-hoc enumeration from adhoc-pairs.ts. Family
  // membership hash: a new pair is submitted once, the family resubmits
  // when the pair set changes.
  const pairSlugs = new Set<string>();
  await Promise.all(
    COMPARE_PAIRS.map(async (pair) => {
      const [p, q] = await Promise.all([
        getProvider(pair.providerA),
        getProvider(pair.providerB),
      ]);
      if (p && q) pairSlugs.add(pair.slug);
    }),
  );
  for (const pair of adHocPairs(profiles)) {
    pairSlugs.add(pair.slug);
  }
  const compareFp = setFingerprint([...pairSlugs]);
  for (const slug of pairSlugs) {
    map[`${SITE.url}/compare/${slug}`] = compareFp;
  }

  return map;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Read the previous map first: buildFingerprintMap needs it to carry
  // fingerprints over on transient per-family loader failures.
  const prevSnap = await readCohortSnapshot<FingerprintMap>(
    FINGERPRINT_KEY,
    FINGERPRINT_MAX_AGE_MS,
  );
  const next = await buildFingerprintMap(prevSnap?.data ?? {});

  // First run (no previous map in KV): submit NOTHING, just store the
  // map. Submitting here would be one final mega-batch of every url —
  // exactly the batch-mode pattern this route exists to avoid. From the
  // next run on, only real diffs go out.
  if (!prevSnap?.data) {
    await writeCohortSnapshot(FINGERPRINT_KEY, next);
    return NextResponse.json(
      {
        ok: true,
        submitted: 0,
        batches: 0,
        message: "first run: stored fingerprint baseline, submitted nothing",
        tracked: Object.keys(next).length,
        changed: 0,
        added: 0,
        removed: 0,
        firstRun: true,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const prev = prevSnap.data;
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [url, fp] of Object.entries(next)) {
    if (!(url in prev)) added.push(url);
    else if (prev[url] !== fp) changed.push(url);
  }
  for (const url of Object.keys(prev)) {
    if (!(url in next)) removed.push(url);
  }

  const host = new URL(SITE.url).host;
  const result = await pingIndexNow([...changed, ...added, ...removed], {
    host,
  });

  // Persist the new map only after a successful ping (an empty diff
  // counts as success and refreshes the blob's TTL). On failure the old
  // map stays, so the next run retries the same diff.
  if (result.ok) {
    await writeCohortSnapshot(FINGERPRINT_KEY, next);
  }

  return NextResponse.json(
    {
      ...result,
      tracked: Object.keys(next).length,
      changed: changed.length,
      added: added.length,
      removed: removed.length,
      firstRun: false,
    },
    {
      status: result.ok ? 200 : 502,
      headers: { "cache-control": "no-store" },
    },
  );
}
