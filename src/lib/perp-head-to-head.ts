import { getProviders } from "@/lib/providers";
import { PERP_VENUES } from "@/lib/perp-stats";
import { PERP_VENUE_META } from "@/lib/perp-venue-context";
import { isPairLinkable, liveSharedBenchCount } from "@/lib/related-providers";

export type PerpHeadToHead = { slug: string; aName: string; bName: string; count: number };

/** The perp venue pairs with the most live benchmarks in common, each
 *  with an indexable compare page. The hub ranked 19 venues and linked
 *  none of the 383 compare pages, the template that converts best on
 *  the site (audit 2026-09-22); the per-asset pages carry the same
 *  block. Pairs go through isPairLinkable so no link lands on a noindex
 *  page; product slugs follow PERP_VENUE_META (gmx-v2 is /products/gmx,
 *  trade-xyz is /products/xyz). */
export async function perpHeadToHead(limit = 8): Promise<PerpHeadToHead[]> {
  const profiles = await getProviders();
  const bySlug = new Map(profiles.map((p) => [p.slug, p]));
  const slugs = [...new Set(PERP_VENUES.map((v) => PERP_VENUE_META[v.slug]?.productSlug ?? v.slug))];
  const out: PerpHeadToHead[] = [];
  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      const a = bySlug.get(slugs[i]);
      const b = bySlug.get(slugs[j]);
      if (!a || !b) continue;
      const [x, y] = a.slug < b.slug ? [a, b] : [b, a];
      const pairSlug = `${x.slug}-vs-${y.slug}`;
      if (!isPairLinkable(pairSlug, x.appearances, y.appearances)) continue;
      out.push({ slug: pairSlug, aName: x.name, bName: y.name, count: liveSharedBenchCount(x.appearances, y.appearances) });
    }
  }
  return out.sort((p, q) => q.count - p.count || p.slug.localeCompare(q.slug)).slice(0, limit);
}
