/**
 * JSON Feed 1.1 (https://jsonfeed.org/version/1.1) mirror of /rss.xml.
 *
 * Modern feed readers + several AI agent tools (Perplexity's crawler,
 * LangChain document loaders, MCP clients) prefer JSON Feed over RSS
 * because JSON is trivial to parse without an XML dependency. RSS
 * stays as the canonical feed for legacy aggregators; feed.json ships
 * the same entries as a companion so tooling that only speaks JSON
 * also picks up new benches without a custom scraper.
 *
 * Same freshness contract as rss.xml: pubDate per item = bench first
 * commit; feed-level `date_modified` = generation time so aggregators
 * see the feed as fresh whenever a headline number changes. Cache 5 min
 * edge TTL, same as RSS.
 */

import { NextResponse } from "next/server";
import { AllBenchmarksDraftError, loadAllBenchmarks } from "@/lib/spec";
import { getBenchCreatedAt } from "@/lib/seo/bench-dates";
import { headlineSentence } from "@/lib/citation";
import { SITE } from "@/data/site";
import type { Benchmark } from "@/types/benchmark";

export const revalidate = 300;

function itemContentText(b: Benchmark): string {
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
      return NextResponse.json(
        { error: "benchmarks_unavailable" },
        {
          status: 503,
          headers: {
            "cache-control": "no-store",
            "retry-after": "60",
          },
        },
      );
    }
    throw err;
  }
  const live = all.filter((b) => b.editorialStatus === "live");

  const items = live
    .map((b) => ({ bench: b, pubDate: getBenchCreatedAt(b.slug) }))
    .sort((a, c) => c.pubDate.getTime() - a.pubDate.getTime())
    .map(({ bench: b, pubDate }) => {
      const url = `${SITE.url}/benchmarks/${b.slug}`;
      return {
        id: url,
        url,
        title: b.title,
        content_text: itemContentText(b),
        summary: b.subtitle,
        date_published: pubDate.toISOString(),
        ...(b.lastRunAt ? { date_modified: b.lastRunAt } : {}),
        tags: [b.category],
        authors: [{ name: "OpenChainBench", url: SITE.url }],
      };
    });

  const feed = {
    version: "https://jsonfeed.org/version/1.1",
    title: "OpenChainBench benchmark releases",
    home_page_url: SITE.url,
    feed_url: `${SITE.url}/feed.json`,
    description:
      "Live measurements for crypto infrastructure: RPCs, oracles, aggregators, bridges, prediction markets. One entry per public benchmark.",
    language: "en",
    icon: `${SITE.url}/logo.png`,
    favicon: `${SITE.url}/icon`,
    authors: [{ name: "OpenChainBench", url: SITE.url }],
    date_modified: new Date().toISOString(),
    items,
  };

  return NextResponse.json(feed, {
    headers: {
      "content-type": "application/feed+json; charset=utf-8",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
