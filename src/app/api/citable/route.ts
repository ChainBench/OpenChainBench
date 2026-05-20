import { NextResponse } from "next/server";
import { getBenchmarks } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import { fieldValue, leader, headlineSentence } from "@/lib/citation";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const revalidate = 60;

/**
 * Flat machine-readable index of every citable benchmark. Designed to be
 * the **first** endpoint an AI agent or journalist crawls - gives them
 * everything they need to decide whether to deep-link to a specific bench.
 *
 * License is intentionally surfaced per-row so downstream agents can
 * cite without needing to read the footer of every page.
 */
export async function GET(req: Request) {
  const r = rateLimit(clientKey(req, "citable"), 60, 60);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const benches = (await getBenchmarks()).filter((b) => b.editorialStatus === "live");
  const data = benches.map((b) => {
    const top = leader(b);
    return {
      slug: b.slug,
      title: b.title,
      category: b.category,
      metric: b.metric,
      unit: b.unit,
      status: b.status,
      value: fieldValue(b),
      leader: top ? { name: top.name, slug: top.slug, value: top.value } : null,
      sampleSize: b.sampleSize,
      asOf: b.lastRunAt,
      headline: headlineSentence(b),
      url: `${SITE.url}/benchmarks/${b.slug}`,
      api: `${SITE.url}/api/stat/${b.slug}`,
      ogImage: `${SITE.url}/api/og/${b.slug}`,
      source: b.source,
      license: "CC-BY-4.0",
    };
  });

  return NextResponse.json(
    {
      site: { name: SITE.name, url: SITE.url, license: "CC-BY-4.0" },
      count: data.length,
      benchmarks: data,
    },
    {
      headers: {
        "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
        "access-control-allow-origin": "*",
      },
    },
  );
}
