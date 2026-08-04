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
};

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
  return reports.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
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
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs
    .readdirSync(REPORTS_DIR)
    .filter((f) => fs.statSync(path.join(REPORTS_DIR, f)).isDirectory());
}
