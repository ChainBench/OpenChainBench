import { getBenchmarks } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import { headlineSentence } from "@/lib/citation";

export const runtime = "nodejs";
export const revalidate = 300;

/**
 * Plain-text index following the llmstxt.org convention. Helps LLM
 * crawlers (ChatGPT, Claude, Perplexity, Gemini) discover the citable
 * surface of the site in one cheap pull, instead of indexing every page.
 *
 * https://llmstxt.org for the spec.
 */
export async function GET() {
  const benches = await getBenchmarks();

  const lines: string[] = [];
  lines.push(`# OpenChainBench`);
  lines.push("");
  lines.push(`> ${SITE.description}`);
  lines.push("");
  lines.push(
    `OpenChainBench publishes open, reproducible benchmarks for crypto infrastructure. Every benchmark below is licensed CC-BY-4.0; numbers refresh on a 60-second ISR cycle.`,
  );
  lines.push("");
  lines.push(`## Machine-readable indexes`);
  lines.push("");
  lines.push(`- [Citable index (JSON)](${SITE.url}/api/citable): flat list of all benchmarks with current values, ready for one-shot lookup.`);
  lines.push(`- [OpenAPI schema](${SITE.url}/api/openapi.json): full description of every endpoint.`);
  lines.push(`- [MCP server](${SITE.url}/api/mcp/sse): SSE transport, exposes \`list_benchmarks\`, \`get_benchmark\`, \`query_prom\` tools.`);
  lines.push("");
  lines.push(`## Benchmarks`);
  lines.push("");
  for (const b of benches) {
    lines.push(`### ${b.title}`);
    lines.push(`- Page: ${SITE.url}/benchmarks/${b.slug}`);
    lines.push(`- JSON: ${SITE.url}/api/stat/${b.slug}`);
    lines.push(`- Category: ${b.category}`);
    lines.push(`- Metric: ${b.metric} (${b.unit})`);
    lines.push(`- Headline: ${headlineSentence(b)}`);
    lines.push("");
  }

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=900",
      "access-control-allow-origin": "*",
    },
  });
}
