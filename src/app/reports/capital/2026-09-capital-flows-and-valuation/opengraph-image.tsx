import OG, { alt, contentType, size } from "../../[category]/[slug]/opengraph-image";

/** Same card as the MDX reports, for the live report's own segment. */
export const runtime = "nodejs";
export const revalidate = 86400;
export { alt, contentType, size };

export default function LiveReportOG() {
  return OG({ params: Promise.resolve({ category: "capital", slug: "2026-09-capital-flows-and-valuation" }) });
}
