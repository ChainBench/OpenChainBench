import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";
import { fetchHlCohort } from "@/lib/hl-builder-stats";

export const runtime = "nodejs";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OG({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let name = slug;
  try {
    const cohort = await fetchHlCohort();
    const row = cohort?.rows.find((r) => r.slug === slug);
    if (row?.name) name = row.name;
  } catch {
    // fall back to slug-derived name
  }

  return renderHubOG({
    kicker: "Hyperliquid frontend",
    headline: `${name}.`,
    subline: `Revenue, volume and daily users for the ${name} Hyperliquid frontend. Live data from a local HL node tailing every fill.`,
  });
}
