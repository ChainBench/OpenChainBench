import { NextResponse } from "next/server";
import { getAllReports } from "@/lib/reports/loader";
import { SITE } from "@/data/site";

export const revalidate = 3600;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toRfc822(d: Date): string {
  return d.toUTCString().replace("GMT", "+0000");
}

export async function GET() {
  const reports = getAllReports();
  const self = `${SITE.url}/reports/rss.xml`;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
  lines.push("  <channel>");
  lines.push(
    `    <title>${escapeXml("OpenChainBench Reports")}</title>`,
  );
  lines.push(`    <link>${SITE.url}/reports</link>`);
  lines.push(
    `    <description>${escapeXml("Monthly and quarterly research on crypto infrastructure performance — RPC, bridges, prediction markets. Citable, reproducible, CC BY 4.0.")}</description>`,
  );
  lines.push("    <language>en</language>");
  lines.push(`    <lastBuildDate>${toRfc822(new Date())}</lastBuildDate>`);
  lines.push(
    `    <atom:link href="${self}" rel="self" type="application/rss+xml" />`,
  );

  for (const r of reports) {
    const link = `${SITE.url}/reports/${r.categorySlug}/${r.slug}`;
    lines.push("    <item>");
    lines.push(`      <title>${escapeXml(r.title)}</title>`);
    lines.push(`      <link>${link}</link>`);
    lines.push(`      <guid isPermaLink="true">${link}</guid>`);
    lines.push(
      `      <pubDate>${toRfc822(new Date(r.publishedAt))}</pubDate>`,
    );
    lines.push(`      <category>${escapeXml(r.categorySlug)}</category>`);
    lines.push(
      `      <description>${escapeXml(r.summary)}</description>`,
    );
    lines.push("    </item>");
  }

  lines.push("  </channel>");
  lines.push("</rss>");

  return new NextResponse(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
