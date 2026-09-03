import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";
import { PERP_VENUES } from "@/lib/perp-stats";

export const runtime = "nodejs";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OG({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cohortSlug = slug === "gmx" ? "gmx-v2" : slug;
  const venue = PERP_VENUES.find((v) => v.slug === cohortSlug);
  const name = venue?.name ?? slug;
  const chain = venue?.chain ?? "";

  return renderHubOG({
    kicker: "Perp DEX benchmark",
    headline: `${name} benchmark.`,
    subline: `Live volume, open interest, all-in fees and funding rate for ${name}${chain ? ` on ${chain}` : ""}. Compared against every major perp exchange.`,
  });
}
