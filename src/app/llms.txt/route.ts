import { getBenchmarks } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import { AllBenchmarksDraftError } from "@/lib/spec";
import { groundingTraceLine } from "@/lib/citation";

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
  let benches;
  try {
    benches = await getBenchmarks();
  } catch (err) {
    if (err instanceof AllBenchmarksDraftError) {
      return new Response("benchmarks_unavailable\n", {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": "60",
          "access-control-allow-origin": "*",
        },
      });
    }
    throw err;
  }

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
  lines.push(`- [LLM context (Markdown)](${SITE.url}/api/llm-context): all ${benches.length} benchmarks + rankings + methodology in one Markdown blob, ready to paste into a system prompt.`);
  lines.push(`- [OpenAPI schema](${SITE.url}/api/openapi.json): full description of every endpoint.`);
  lines.push(`- [MCP server docs](${SITE.url}/mcp): install instructions (Claude Desktop, Cursor, generic clients) for the MCP server at ${SITE.url}/api/mcp/mcp, which exposes \`list_benchmarks\`, \`get_benchmark\`, \`query_prom\` tools + \`openchainbench://benchmark/{slug}\` resources over Streamable HTTP (JSON-RPC via POST; the endpoint is not browsable with GET).`);
  lines.push("");
  lines.push(`## Benchmarks`);
  lines.push("");
  for (const b of benches) {
    lines.push(`### ${b.title}`);
    lines.push(`- Page: ${SITE.url}/benchmarks/${b.slug}`);
    lines.push(`- JSON: ${SITE.url}/api/stat/${b.slug}`);
    lines.push(`- Category: ${b.category}`);
    lines.push(`- Metric: ${b.metric} (${b.unit})`);
    lines.push(`- Headline: ${groundingTraceLine(b, SITE.url)}`);
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
