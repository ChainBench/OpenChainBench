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
 * Hybrid threshold (SEO audit 2026-07-05): both providers in
 * BRAND_WHITELIST → emit at >= 1 shared bench; otherwise >= 3. See the
 * sitemap for the thin-content rationale (Bing penalty, 2026-07-05).
 */
export type AdHocPair = { a: string; b: string; slug: string };

export function adHocPairs(profiles: ProviderProfile[]): AdHocPair[] {
  const benchesBySlug = new Map<string, Set<string>>();
  for (const p of profiles) {
    if (HEX_SLUG_RE.test(p.slug)) continue;
    if (CHAIN_BY_SLUG.has(p.slug)) continue;
    const benches = new Set(p.appearances.map((a) => a.benchmark.slug));
    if (benches.size >= 1) benchesBySlug.set(p.slug, benches);
  }

  const out: AdHocPair[] = [];
  const slugList = [...benchesBySlug.keys()].sort();
  for (let i = 0; i < slugList.length; i += 1) {
    const aSlug = slugList[i];
    const aBenches = benchesBySlug.get(aSlug)!;
    for (let j = i + 1; j < slugList.length; j += 1) {
      const bSlug = slugList[j];
      const bBenches = benchesBySlug.get(bSlug)!;
      let shared = 0;
      for (const s of aBenches) if (bBenches.has(s)) shared += 1;
      const bothBrand = BRAND_WHITELIST.has(aSlug) && BRAND_WHITELIST.has(bSlug);
      const threshold = bothBrand ? 1 : 3;
      if (shared < threshold) continue;
      out.push({ a: aSlug, b: bSlug, slug: `${aSlug}-vs-${bSlug}` });
    }
  }
  return out;
}
