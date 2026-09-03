import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";
import { REPORT_CATEGORY_META } from "@/lib/reports/loader";

export const runtime = "nodejs";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OG({ params }: { params: Promise<{ category: string }> }) {
  const { category } = await params;
  const meta = REPORT_CATEGORY_META[category];
  const label = meta?.label ?? category;
  const description = meta?.description ?? "In-depth analysis backed by live OpenChainBench benchmark data.";

  return renderHubOG({
    kicker: `${label} reports`,
    headline: `${label} reports.`,
    subline: description,
  });
}
