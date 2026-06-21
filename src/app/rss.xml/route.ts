/**
 * RSS 2.0 feed listing every live benchmark.
 *
 * Consumed by crypto news aggregators and journalists who watch for
 * new benchmark releases (DefiLlama news pipeline, Wu Blockchain
 * curation lists, custom Slack RSS-to-channel bots, etc). One entry
 * per live bench, ordered by `datePublished` descending, with the
 * canonical /benchmarks/<slug> link and an auto-generated headline
 * sentence as the item description.
 *
 * Why RSS 2.0 and not Atom: Atom is technically cleaner but every
 * legacy aggregator on the planet speaks RSS 2.0 and most fall back
 * to title-only if the feed declares Atom. RSS 2.0 maximises pickup.
 *
 * Freshness model:
 *   - `pubDate` per item = the bench's first commit (stable, from
 *     `bench-dates.ts`).
 *   - `lastBuildDate` on the channel = the most recent bench's pubDate.
 *     Aggregators use this to decide whether to refetch the body.
 *
 * Cache: 5 min edge TTL so a brand new bench surfaces in aggregator
 * polls within minutes of being merged, without hammering the data
 * layer on every poll.
 */

import { NextResponse } from "next/server";
import { AllBenchmarksDraftError, loadAllBenchmarks } from "@/lib/spec";
import { getBenchCreatedAt } from "@/lib/seo/bench-dates";
import { headlineSentence } from "@/lib/citation";
import { SITE } from "@/data/site";
import type { Benchmark } from "@/types/benchmark";

export const revalidate = 300;

const FEED_TITLE = "OpenChainBench benchmark releases";
const FEED_DESCRIPTION =
  "Live measurements for crypto infrastructure: RPCs, oracles, aggregators, bridges, prediction markets. One entry per public benchmark.";

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toRfc822(d: Date): string {
  // RSS 2.0 dates are RFC 822 with a 4-digit year. Native `toUTCString`
  // returns the same shape; only swap the 2-letter "GMT" trailer for
  // "+0000" which a few stricter parsers prefer.
  return d.toUTCString().replace("GMT", "+0000");
}

function itemDescription(b: Benchmark): string {
  const sentence = headlineSentence(b);
  if (sentence) return `${sentence} ${b.subtitle}`.trim();
  return b.subtitle;
}

export async function GET() {
  let all;
  try {
    all = await loadAllBenchmarks();
  } catch (err) {
    if (err instanceof AllBenchmarksDraftError) {
      return new Response("benchmarks_unavailable\n", {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": "60",
        },
      });
    }
    throw err;
  }
  const live = all.filter((b) => b.editorialStatus === "live");

  const items = live
    .map((b) => ({
      bench: b,
      pubDate: getBenchCreatedAt(b.slug),
    }))
    .sort((a, c) => c.pubDate.getTime() - a.pubDate.getTime());

  const latest = items[0]?.pubDate ?? new Date();
  const self = `${SITE.url}/rss.xml`;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
  );
  lines.push("  <channel>");
  lines.push(`    <title>${escapeXml(FEED_TITLE)}</title>`);
  lines.push(`    <link>${SITE.url}</link>`);
  lines.push(`    <description>${escapeXml(FEED_DESCRIPTION)}</description>`);
  lines.push("    <language>en</language>");
  lines.push(`    <lastBuildDate>${toRfc822(latest)}</lastBuildDate>`);
  lines.push(
    `    <atom:link href="${self}" rel="self" type="application/rss+xml" />`,
  );

  for (const { bench, pubDate } of items) {
    const link = `${SITE.url}/benchmarks/${bench.slug}`;
    const title = bench.seoTitle ?? bench.title;
    lines.push("    <item>");
    lines.push(`      <title>${escapeXml(title)}</title>`);
    lines.push(`      <link>${link}</link>`);
    lines.push(`      <guid isPermaLink="true">${link}</guid>`);
    lines.push(`      <pubDate>${toRfc822(pubDate)}</pubDate>`);
    lines.push(`      <category>${escapeXml(bench.category)}</category>`);
    lines.push(
      `      <description>${escapeXml(itemDescription(bench))}</description>`,
    );
    lines.push("    </item>");
  }

  lines.push("  </channel>");
  lines.push("</rss>");

  return new NextResponse(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      // 5 min CDN cache + 1 h SWR so a brand-new bench reaches a polling
      // aggregator within minutes, but a flood of polls during quiet hours
      // doesn't re-render the route.
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
