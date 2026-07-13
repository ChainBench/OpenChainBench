import { NextResponse } from "next/server";
import { getBenchmarks } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import { AllBenchmarksDraftError } from "@/lib/spec";
import { citableAsOf, citeBundle, fieldValue, leader, headlineSentence } from "@/lib/citation";
import { valueInDeclaredUnit } from "@/lib/format";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const revalidate = 60;

/** Short 503 with a Retry-After hint, served when the aggregator has
 *  no live snapshot to surface (Prom blackout + cold KV). Beats serving
 *  an all-draft index that downstream LLM agents would treat as truth. */
function unavailable(): NextResponse {
  return NextResponse.json(
    { error: "benchmarks_unavailable", retryAfterSec: 60 },
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "retry-after": "60",
        "access-control-allow-origin": "*",
      },
    },
  );
}

/**
 * Flat machine-readable index of every citable benchmark. Designed to be
 * the **first** endpoint an AI agent or journalist crawls. Gives them
 * everything they need to decide whether to deep-link to a specific bench.
 *
 * License is intentionally surfaced per-row so downstream agents can
 * cite without needing to read the footer of every page.
 */
export async function GET(req: Request) {
  const r = rateLimit(clientKey(req, "citable"), 60, 60, req);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  let benches;
  try {
    benches = (await getBenchmarks()).filter(
      (b) => b.editorialStatus === "live",
    );
  } catch (err) {
    if (err instanceof AllBenchmarksDraftError) return unavailable();
    throw err;
  }
  const data = benches.map((b) => {
    const top = leader(b);
    // Insufficient aggregate: explicitly null the value + leader so
    // downstream LLM agents and journalists do not quote a number drawn
    // from an undersized field. The headline sentence is rewritten to
    // "insufficient data" by headlineSentence above.
    const insufficient = b.dataConfidence === "insufficient";
    // `value` and `leader.value` are published in the declared `unit`.
    // Latency benches with unit "s" store ms internally (fmtUnit
    // convention); valueInDeclaredUnit converts so the JSON never claims
    // 645 seconds for a 645 ms head lag.
    const raw = insufficient ? null : fieldValue(b);
    return {
      slug: b.slug,
      title: b.title,
      category: b.category,
      metric: b.metric,
      unit: b.unit,
      status: b.status,
      value: raw == null ? null : valueInDeclaredUnit(raw, b.unit),
      leader:
        insufficient
          ? null
          : top
            ? {
                name: top.name,
                slug: top.slug,
                value: valueInDeclaredUnit(top.value, b.unit),
              }
            : null,
      sampleSize: b.sampleSize,
      expectedN: b.expectedN,
      dataConfidence: b.dataConfidence,
      asOf: citableAsOf(b),
      headline: headlineSentence(b),
      url: `${SITE.url}/benchmarks/${b.slug}`,
      api: `${SITE.url}/api/stat/${b.slug}`,
      ogImage: `${SITE.url}/api/og/${b.slug}`,
      source: b.source,
      license: "CC-BY-4.0",
      cite: citeBundle(b, SITE.url),
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
        "cache-control": "public, s-maxage=300, stale-while-revalidate=900",
        "access-control-allow-origin": "*",
      },
    },
  );
}
