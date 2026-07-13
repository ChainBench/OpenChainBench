import { NextResponse } from "next/server";
import { canonicalize, getProvider } from "@/lib/providers";
import { valueInDeclaredUnit } from "@/lib/format";
import { canonicalPairSlug } from "@/lib/compare-pairing-shared";
import { citableAsOf } from "@/lib/citation";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { SLUG_RE } from "@/lib/slug";
import { SITE } from "@/data/site";

export const runtime = "nodejs";
export const revalidate = 60;

/**
 * Head-to-head comparison of two providers as a single citable payload.
 *
 * LLMs asked "Mobula vs Codex head lag" would otherwise need two
 * /api/stat calls plus their own delta reasoning; this endpoint returns
 * one flat structure with per-benchmark p50 for each side, the winner
 * on the metric's higher-is-better convention, and the absolute delta.
 *
 * The intersection logic mirrors src/lib/related-providers.ts and the
 * HTML /compare/{slug} page: shared benchmark = both providers appear
 * in it. This route intentionally returns a flat leader-p50 payload
 * only (no chain/region breakdowns, no cache-heavy fan out) so the
 * agent tool call stays fast and cheap.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ a: string; b: string }> },
) {
  const r = rateLimit(clientKey(req, "compare"), 60, 60, req);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const { a: aRaw, b: bRaw } = await params;
  if (!SLUG_RE.test(aRaw) || !SLUG_RE.test(bRaw)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }
  const aCanon = canonicalize(aRaw).slug;
  const bCanon = canonicalize(bRaw).slug;
  if (aCanon === bCanon) {
    return NextResponse.json(
      { error: "same_provider", slug: aCanon },
      { status: 400 },
    );
  }

  const [aProfile, bProfile] = await Promise.all([
    getProvider(aCanon),
    getProvider(bCanon),
  ]);
  if (!aProfile || !bProfile) {
    return NextResponse.json(
      {
        error: "unknown_provider",
        missing: !aProfile ? aCanon : bCanon,
      },
      { status: 404, headers: { "cache-control": "public, s-maxage=60" } },
    );
  }

  // Intersection of the two providers' bench appearances. Same shape as
  // src/lib/related-providers.ts:78 so this endpoint and the "compare
  // with" cards on /products/[slug] never disagree on which benches show
  // up in the head-to-head.
  const aByBench = new Map(
    aProfile.appearances.map((x) => [x.benchmark.slug, x] as const),
  );
  const sharedSlugs = bProfile.appearances
    .filter((x) => aByBench.has(x.benchmark.slug))
    .map((x) => x.benchmark.slug);

  if (sharedSlugs.length === 0) {
    return NextResponse.json(
      {
        error: "no_shared_benchmark",
        a: { slug: aProfile.slug, name: aProfile.name },
        b: { slug: bProfile.slug, name: bProfile.name },
      },
      { status: 404, headers: { "cache-control": "public, s-maxage=60" } },
    );
  }

  // Publish p50 in the declared unit (unit "s" benches store ms
  // internally — same rule as /api/citable and /api/stat).
  const shared = sharedSlugs
    .map((slug) => {
      const aEntry = aByBench.get(slug);
      const bEntry = bProfile.appearances.find(
        (x) => x.benchmark.slug === slug,
      );
      if (!aEntry || !bEntry) return null;
      const bench = aEntry.benchmark;
      const higherIsBetter = bench.higherIsBetter === true;
      const aP50Raw = aEntry.result.ms.p50;
      const bP50Raw = bEntry.result.ms.p50;
      const aValue =
        aP50Raw > 0 ? valueInDeclaredUnit(aP50Raw, bench.unit) : null;
      const bValue =
        bP50Raw > 0 ? valueInDeclaredUnit(bP50Raw, bench.unit) : null;
      let winner: "a" | "b" | "tie";
      if (aValue == null && bValue == null) winner = "tie";
      else if (aValue == null) winner = "b";
      else if (bValue == null) winner = "a";
      else if (aValue === bValue) winner = "tie";
      else if (higherIsBetter) winner = aValue > bValue ? "a" : "b";
      else winner = aValue < bValue ? "a" : "b";
      const delta =
        aValue != null && bValue != null ? aValue - bValue : null;
      return {
        slug: bench.slug,
        title: bench.title,
        category: bench.category,
        metric: bench.metric,
        unit: bench.unit,
        higherIsBetter,
        aValue,
        bValue,
        winner,
        delta,
        pageUrl: `${SITE.url}/benchmarks/${bench.slug}`,
        asOf: citableAsOf(bench),
      };
    })
    .filter(
      (row): row is Exclude<typeof row, null> => row !== null,
    );

  const pairSlug = canonicalPairSlug(aProfile.slug, bProfile.slug);
  const totalWins = shared.reduce(
    (acc, row) => {
      if (row.winner === "a") acc.a += 1;
      else if (row.winner === "b") acc.b += 1;
      else acc.tie += 1;
      return acc;
    },
    { a: 0, b: 0, tie: 0 },
  );

  return NextResponse.json(
    {
      a: { slug: aProfile.slug, name: aProfile.name },
      b: { slug: bProfile.slug, name: bProfile.name },
      totalWins,
      shared,
      comparePageUrl: `${SITE.url}/compare/${pairSlug}`,
      license: "CC-BY-4.0",
    },
    {
      headers: {
        "cache-control":
          "public, s-maxage=60, stale-while-revalidate=300",
        "access-control-allow-origin": "*",
      },
    },
  );
}
