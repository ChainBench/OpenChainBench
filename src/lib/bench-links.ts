import { SITE } from "@/data/site";
import { venueTypeQuery } from "@/lib/venue-type-filter";
import type { ProviderVenueType } from "@/types/benchmark";

export function benchOgImage(
  slug: string,
  venueType?: ProviderVenueType,
): string {
  return `${SITE.url}/api/og/${slug}${venueTypeQuery(venueType)}`;
}
