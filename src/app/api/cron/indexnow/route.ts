import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getBenchmarks } from "@/data/benchmarks";
import { getProviderSlugs } from "@/lib/providers";
import { loadAllAlternatives } from "@/lib/alternatives";
import { SITE } from "@/data/site";
import { pingIndexNow } from "@/lib/indexnow";
import {
  readCohortSnapshot,
  writeCohortSnapshot,
} from "@/lib/cohort-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
 * Fingerprint inputs per URL family:
 *   - Bench pages: leader provider slug + rounded leader value + seoTitle
 *     ("the page's headline claim changed").
 *   - Product / alternative pages: membership only (they change rarely;
 *     add/remove is the signal).
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

async function buildFingerprintMap(): Promise<FingerprintMap> {
  const [benches, alternatives, providerSlugs] = await Promise.all([
    getBenchmarks(),
    loadAllAlternatives(),
    getProviderSlugs(),
  ]);

  const map: FingerprintMap = {};

  // Static hubs: fingerprinted on the deploy timestamp so each deploy
  // re-submits them exactly once.
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
  ];
  for (const path of hubs) {
    map[`${SITE.url}${path}`] = deployFp;
  }

  // Bench pages: fingerprint = the headline claim (leader slug + rounded
  // leader p50 + seoTitle). Rounding to 0.1 units keeps sub-noise metric
  // wobble from triggering a resubmission every hour.
  for (const b of benches) {
    if (b.editorialStatus !== "live") continue;
    const leader = b.results[0];
    const fp = leader
      ? `${leader.slug}:${Math.round(leader.ms.p50 * 10)}:${b.seoTitle ?? ""}`
      : `no-leader:${b.seoTitle ?? ""}`;
    map[`${SITE.url}/benchmarks/${b.slug}`] = shortHash(fp);
  }

  // Product / alternative pages change rarely; membership add/remove is
  // the signal, so a constant fingerprint suffices.
  for (const slug of providerSlugs) {
    map[`${SITE.url}/products/${slug}`] = "exists";
  }
  for (const alt of alternatives) {
    map[`${SITE.url}/alternatives/${alt.slug}`] = "exists";
  }

  return map;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [next, prevSnap] = await Promise.all([
    buildFingerprintMap(),
    readCohortSnapshot<FingerprintMap>(
      FINGERPRINT_KEY,
      FINGERPRINT_MAX_AGE_MS,
    ),
  ]);

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
