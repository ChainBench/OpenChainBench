import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";
import { CATEGORY_BY_SLUG } from "@/lib/categories";

export const runtime = "nodejs";
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
