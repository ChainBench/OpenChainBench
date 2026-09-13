import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";
import { CATEGORY_BY_SLUG } from "@/lib/categories";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OG({ params }: { params: Promise<{ cat: string }> }) {
  const { cat } = await params;
  const entry = CATEGORY_BY_SLUG.get(cat);
  const label = entry?.heading ?? cat;
  const description = entry?.description ?? "Live benchmarks across crypto infrastructure providers.";

  return renderHubOG({
    kicker: `${label} benchmarks`,
    headline: `All ${label} benchmarks.`,
    subline: description,
  });
}
