import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";
import { PERP_VENUES } from "@/lib/perp-stats";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
export const size = OG_SIZE;
export const contentType = "image/png";

function venueName(slug: string): string {
  const cohortSlug = slug === "gmx" ? "gmx-v2" : slug;
  return PERP_VENUES.find((v) => v.slug === cohortSlug)?.name ?? slug;
}

export default async function OG({
  params,
}: {
  params: Promise<{ venueA: string; venueB: string; wallet: string }>;
}) {
  const { venueA, venueB } = await params;
  const nameA = venueName(venueA);
  const nameB = venueName(venueB);

  return renderHubOG({
    kicker: "Fee compare",
    headline: `${nameA} vs ${nameB}.`,
    subline: `Real taker fees paid on ${nameA} vs what they would have cost on ${nameB}. Live on-chain wallet data, no API key.`,
  });
}
