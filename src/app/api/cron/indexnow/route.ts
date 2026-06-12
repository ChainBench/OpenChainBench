import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getBenchmarks } from "@/data/benchmarks";
import { getProviderSlugs } from "@/lib/providers";
import { loadAllAlternatives } from "@/lib/alternatives";
import { SITE } from "@/data/site";
import { pingIndexNow } from "@/lib/indexnow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daily IndexNow ping. Submits every public URL (home, hubs, all live
 * bench detail pages, provider pages, alternative pages) to the
 * IndexNow endpoint so Bing / Yandex / Naver / Seznam re-crawl us in
 * sub-minute.
 *
 * Wiring (operator):
 *   1. Generate a 32-char hex key (`openssl rand -hex 16`).
 *   2. Put it in `public/<key>.txt` (content = the key itself) and
 *      `INDEXNOW_KEY` Vercel env var.
 *   3. `CRON_SECRET` Vercel env var gates this route.
 *   4. vercel.json crons block calls this route once a day.
 *
 * Manual test:
 *   curl https://openchainbench.com/api/cron/indexnow \
 *        -H "Authorization: Bearer ${CRON_SECRET}"
 *
 * Returns `{ok, submitted, batches, message}`. When INDEXNOW_KEY is
 * absent the route still 200s (dry-mode), so deploying this code
 * without the env var doesn't break the cron schedule.
 */

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

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [benches, alternatives, providerSlugs] = await Promise.all([
    getBenchmarks(),
    loadAllAlternatives(),
    getProviderSlugs(),
  ]);

  const urls = new Set<string>();
  urls.add(SITE.url);
  urls.add(`${SITE.url}/benchmarks`);
  urls.add(`${SITE.url}/products`);
  urls.add(`${SITE.url}/methodology`);
  urls.add(`${SITE.url}/about`);
  urls.add(`${SITE.url}/mcp`);
  for (const b of benches) {
    if (b.editorialStatus !== "live") continue;
    urls.add(`${SITE.url}/benchmarks/${b.slug}`);
  }
  for (const slug of providerSlugs) {
    urls.add(`${SITE.url}/products/${slug}`);
  }
  for (const alt of alternatives) {
    urls.add(`${SITE.url}/alternatives/${alt.slug}`);
  }

  const host = new URL(SITE.url).host;
  const result = await pingIndexNow([...urls], { host });

  return NextResponse.json(result, {
    status: result.ok ? 200 : 502,
    headers: { "cache-control": "no-store" },
  });
}
