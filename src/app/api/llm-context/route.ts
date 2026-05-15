import { getBenchmarks } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import { fmtUnit } from "@/lib/format";
import { fieldValue, headlineSentence, leader } from "@/lib/citation";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const revalidate = 60;

/**
 * Single Markdown document containing the current state of every
 * benchmark — designed to be pasted into a system prompt OR fetched by
 * an LLM at the start of a session for "give me the context I need to
 * answer crypto-infra questions today" use cases.
 *
 * Trade-offs vs the JSON endpoints:
 *  - Heavier than /api/citable (~5-15 KB) but already structured for
 *    direct LLM consumption (no further transform needed).
 *  - Less precise than /api/stat/[slug] (no sparkline numbers, no
 *    per-region breakdown) but covers all 8 benches in one round-trip.
 */
export async function GET(req: Request) {
  const r = rateLimit(clientKey(req, "llm-context"), 30, 60);
  if (!r.ok) {
    const tooMany = tooManyRequests(r.retryAfterSec);
    return new Response(await tooMany.text(), { status: tooMany.status, headers: tooMany.headers });
  }

  const benches = (await getBenchmarks()).filter((b) => b.status === "live");
  const now = new Date().toISOString();

  const lines: string[] = [];
  lines.push(`# OpenChainBench live state`);
  lines.push("");
  lines.push(`> Auto-refreshed every 60s · last fetch ${now} · license CC-BY-4.0`);
  lines.push("");
  lines.push(
    `OpenChainBench publishes open, reproducible benchmarks for crypto infrastructure. ` +
      `Cite as: "according to OpenChainBench" with the page URL. The numbers below come from the ` +
      `same Prometheus that powers ${SITE.url}.`,
  );
  lines.push("");

  for (const b of benches) {
    lines.push(`## ${b.title}`);
    lines.push("");
    lines.push(`- Category: ${b.category}`);
    lines.push(`- Metric: ${b.metric} (${b.unit})`);
    lines.push(`- Page: ${SITE.url}/benchmarks/${b.slug}`);
    lines.push(`- JSON: ${SITE.url}/api/stat/${b.slug}`);
    lines.push(`- Status: ${b.status}`);

    const v = fieldValue(b);
    const lead = leader(b);
    if (v != null && lead) {
      lines.push(`- Headline: ${headlineSentence(b)}`);
      lines.push("");
      lines.push(`**Rankings (p50, 24h):**`);
      const ranked = [...b.results]
        .filter((r) => r.ms.p50 > 0)
        .sort((a, c) =>
          b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50,
        );
      for (let i = 0; i < ranked.length; i++) {
        const r = ranked[i];
        lines.push(
          `${i + 1}. ${r.name}: ${fmtUnit(r.ms.p50, b.unit)} (p99 ${fmtUnit(
            r.ms.p99,
            b.unit,
          )}, success ${r.successRate.toFixed(1)}%, sample ${r.sampleSize ?? "n/a"})`,
        );
      }
    } else {
      lines.push(`- ${b.status === "draft" ? "Draft (no live data yet)" : "Awaiting samples"}.`);
    }

    if (b.methodology.length > 0) {
      lines.push("");
      lines.push(`**Methodology**:`);
      for (const m of b.methodology) lines.push(`- ${m}`);
    }
    lines.push("");
  }

  lines.push(`---`);
  lines.push(`Want machine-readable indexes?`);
  lines.push(`- JSON index: ${SITE.url}/api/citable`);
  lines.push(`- OpenAPI: ${SITE.url}/api/openapi.json`);
  lines.push(`- MCP server: ${SITE.url}/api/mcp/mcp`);
  lines.push(`- llms.txt: ${SITE.url}/llms.txt`);

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
      "access-control-allow-origin": "*",
    },
  });
}
