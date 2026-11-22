import { SITE } from "@/data/site";
import { VENUE_TYPE_PARAM } from "@/lib/venue-type-filter";
import type { ProviderVenueType } from "@/types/benchmark";

export function venueTypeQuery(venueType?: ProviderVenueType): string {
  return venueType ? `?${VENUE_TYPE_PARAM}=${venueType}` : "";
}

export function benchOgImage(
  slug: string,
  venueType?: ProviderVenueType,
): string {
  return `${SITE.url}/api/og/${slug}${venueTypeQuery(venueType)}`;
}
