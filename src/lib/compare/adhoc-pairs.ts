import { CHAIN_BY_SLUG } from "@/lib/chains";
import { BRAND_WHITELIST } from "@/lib/compare/brand-whitelist";
import type { ProviderProfile } from "@/lib/providers";

const HEX_SLUG_RE = /^0x[0-9a-f]{4,}$/i;

/**
 * Ad-hoc compare pair enumeration, shared by sitemap.ts and the
 * /compare index. Single source of truth so every pair URL the sitemap
 * advertises is also internally linked somewhere — Ahrefs flagged
 * sitemap-only pairs (e.g. binance-vs-tenderly) as orphan pages when
 * the two generators drifted.
 *
 * Hybrid threshold (SEO audit 2026-07-08, tightened from 2026-07-05):
 * both providers in BRAND_WHITELIST → emit at >= 2 shared benches with
 * LIVE data for both; otherwise >= 3. "Live" mirrors liveResults():
 * availability !== "unavailable" and p50 > 0, read straight off the
 * already-loaded appearance results (no extra Prom round trip).
 *
 * Rationale for the bump from >= 1 structural to >= 2 live: the old
 * rule emitted ~70 pairs whose single shared bench often had no live
 * data ("awaiting live measurements", ~2 KB body). The >= 2 live floor
 * also matches the render-time noindex gate on /compare/[slug] (pairs
 * resolving < 2 benches with values are noindexed), so the sitemap
 * never advertises a URL the page itself marks noindex. Tradeoff: a
 * brand pair with exactly one live shared bench (real data, one card)
 * leaves the sitemap and internal link lists too. It still renders at
 * its URL via the ad-hoc resolver, so nothing 404s; it just stops
 * being advertised until a second shared bench goes live.
 */
export type AdHocPair = { a: string; b: string; slug: string };

export function adHocPairs(profiles: ProviderProfile[]): AdHocPair[] {
  // bench slug → live flag, per provider. A shared bench only counts
  // toward the threshold when it is live for BOTH providers.
  const liveBenchesBySlug = new Map<string, Set<string>>();
  for (const p of profiles) {
    if (HEX_SLUG_RE.test(p.slug)) continue;
    if (CHAIN_BY_SLUG.has(p.slug)) continue;
    const live = new Set<string>();
    for (const a of p.appearances) {
      if (a.result.availability === "unavailable") continue;
      if (a.result.ms.p50 <= 0) continue;
      live.add(a.benchmark.slug);
    }
    if (live.size >= 1) liveBenchesBySlug.set(p.slug, live);
  }

  const out: AdHocPair[] = [];
  const slugList = [...liveBenchesBySlug.keys()].sort();
  for (let i = 0; i < slugList.length; i += 1) {
    const aSlug = slugList[i];
    const aBenches = liveBenchesBySlug.get(aSlug)!;
    for (let j = i + 1; j < slugList.length; j += 1) {
      const bSlug = slugList[j];
      const bBenches = liveBenchesBySlug.get(bSlug)!;
      let sharedLive = 0;
      for (const s of aBenches) if (bBenches.has(s)) sharedLive += 1;
      // Buffer above the render-time noindex gate (< 2 live shared). The
      // page recomputes on its own ISR clock, so a single bench flapping
      // unavailable/back can drop `liveSharedCount` under 2 for one render
      // window while the sitemap (force-dynamic) still lists the pair.
      // Ahrefs then flags "noindex page in sitemap". Requiring >= 3 (brand)
      // and >= 4 (otherwise) here means a single bench flap can't cross
      // both thresholds simultaneously.
      const bothBrand = BRAND_WHITELIST.has(aSlug) && BRAND_WHITELIST.has(bSlug);
      const threshold = bothBrand ? 3 : 4;
      if (sharedLive < threshold) continue;
      out.push({ a: aSlug, b: bSlug, slug: `${aSlug}-vs-${bSlug}` });
    }
  }
  return out;
}
