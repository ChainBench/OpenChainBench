import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const REPORTS_DIR = path.join(process.cwd(), "src/content/reports");

export type ReportMeta = {
  title: string;
  category: string;
  categorySlug: string;
  slug: string;
  publishedAt: string;
  period: string;
  summary: string;
  heroFinding: string;
  author: string;
  readingTime: number;
  ogImage?: string;
  canonical: string;
  draft?: boolean;
  /** True for a report rendered by its own route segment (live data,
   *  no MDX body) instead of the [category]/[slug] MDX page. */
  live?: boolean;
};

export type Report = ReportMeta & {
  content: string;
};

export const REPORT_CATEGORY_META: Record<
  string,
  { label: string; description: string }
> = {
  rpc: {
    label: "RPC",
    description:
      "Public no-key RPC endpoints benchmarked for latency, reliability, and archive depth across EVM chains.",
  },
  bridge: {
    label: "Bridge",
    description:
      "Cross-chain USDC transfer routes benchmarked for quote latency and effective fee.",
  },
  "prediction-markets": {
    label: "Prediction Markets",
    description:
      "On-chain prediction markets benchmarked for quote availability, market coverage, and resolution latency.",
  },
  "data-api": {
    label: "Data API",
    description:
      "Crypto data APIs benchmarked for price feed latency, token metadata coverage, wallet indexing freshness, DEX chain coverage, and NFT data quality.",
  },
};

/**
 * Reports that live as route segments under src/app/reports/<category>/
 * <slug>/page.tsx because every figure on them is read live from the
 * benches. Listed here so the index, the category page, the RSS feed
 * and the sitemap see them like the MDX reports.
 */
export const LIVE_REPORTS: ReportMeta[] = [
  // The State of perp DEXes Q3 2026 report was withdrawn on 2026-09-23
  // pending a rewrite; the mechanism stays for the next live report.
];

function parseReport(filePath: string): Report {
  const raw = fs.readFileSync(filePath, "utf8");
  const { data, content } = matter(raw);
  const rel = filePath.replace(REPORTS_DIR + path.sep, "");
  const categorySlug = rel.split(path.sep)[0];
  return {
    title: String(data.title ?? ""),
    category: String(data.category ?? categorySlug),
    categorySlug,
    slug: String(data.slug ?? ""),
    publishedAt: String(data.publishedAt ?? ""),
    period: String(data.period ?? ""),
    summary: String(data.summary ?? ""),
    heroFinding: String(data.heroFinding ?? ""),
    author: String(data.author ?? "OpenChainBench Research"),
    readingTime: Number(data.readingTime ?? 10),
    ogImage: data.ogImage ? String(data.ogImage) : undefined,
    canonical: String(data.canonical ?? ""),
    draft: Boolean(data.draft ?? false),
    content,
  };
}

export function getAllReports(): Report[] {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  const reports: Report[] = [];
  for (const cat of fs.readdirSync(REPORTS_DIR)) {
    const catDir = path.join(REPORTS_DIR, cat);
    if (!fs.statSync(catDir).isDirectory()) continue;
    for (const file of fs.readdirSync(catDir)) {
      if (!file.endsWith(".mdx")) continue;
      try {
        reports.push(parseReport(path.join(catDir, file)));
      } catch {
        // skip malformed files
      }
    }
  }
  for (const meta of LIVE_REPORTS) reports.push({ ...meta, content: "" });
  return reports
    .filter((r) => !r.draft)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export function getReportsByCategory(categorySlug: string): Report[] {
  return getAllReports().filter((r) => r.categorySlug === categorySlug);
}

export function getReport(
  categorySlug: string,
  slug: string,
): Report | undefined {
  return getAllReports().find(
    (r) => r.categorySlug === categorySlug && r.slug === slug,
  );
}

export function getAllReportCategories(): string[] {
  const fromDisk = fs.existsSync(REPORTS_DIR)
    ? fs.readdirSync(REPORTS_DIR).filter((f) => fs.statSync(path.join(REPORTS_DIR, f)).isDirectory())
    : [];
  return [...new Set([...fromDisk, ...LIVE_REPORTS.map((r) => r.categorySlug)])];
}
