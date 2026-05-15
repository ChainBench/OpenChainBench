import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { getBenchmark, getBenchmarks } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import {
  citationQuote,
  fieldValue,
  headlineSentence,
  leader,
  sparklineFor,
} from "@/lib/citation";
import { Prometheus } from "@/lib/prometheus";

export const runtime = "nodejs";

/**
 * MCP server. Exposes OpenChainBench data to any MCP-capable agent
 * (Claude Desktop, ChatGPT custom tools, generic MCP clients) via three
 * tools that mirror the public REST surface.
 *
 * Connect with the SSE transport at:
 *     https://openchainbench.com/api/mcp/sse
 * or the streamable-HTTP transport at:
 *     https://openchainbench.com/api/mcp/mcp
 */
const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_benchmarks",
      {
        title: "List benchmarks",
        description:
          "Returns the flat index of every published OpenChainBench benchmark with the current headline value, leader and citation URL. Call this first to discover what's available.",
        inputSchema: {},
      },
      async () => {
        const benches = await getBenchmarks();
        const rows = benches.map((b) => {
          const top = leader(b);
          return {
            slug: b.slug,
            title: b.title,
            category: b.category,
            metric: b.metric,
            unit: b.unit,
            status: b.status,
            value: fieldValue(b),
            leader: top,
            headline: headlineSentence(b),
            url: `${SITE.url}/benchmarks/${b.slug}`,
            asOf: b.lastRunAt,
          };
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ count: rows.length, benchmarks: rows }, null, 2) }],
        };
      },
    );

    server.registerTool(
      "get_benchmark",
      {
        title: "Get a single benchmark",
        description:
          "Returns full detail for one benchmark: rankings, sparkline (24h), headline sentence, pasteable citation quote, and methodology link. Optionally filter by chain and/or region.",
        inputSchema: {
          slug: z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]{0,79}$/)
            .describe("Benchmark slug, e.g. 'aggregator-head-lag'."),
          chain: z
            .string()
            .regex(/^[a-z0-9-]{1,64}$/)
            .optional()
            .describe("Chain label value, e.g. 'base' or 'solana'."),
          region: z
            .string()
            .regex(/^[a-z0-9-]{1,64}$/)
            .optional()
            .describe("Region label value, e.g. 'us-east' or 'eu-west'."),
        },
      },
      async ({ slug, chain, region }) => {
        const b = await getBenchmark(slug, { chain, region });
        if (!b) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "unknown_slug", slug }) }],
            isError: true,
          };
        }
        const top = leader(b);
        const payload = {
          slug: b.slug,
          title: b.title,
          metric: b.metric,
          unit: b.unit,
          status: b.status,
          value: fieldValue(b),
          leader: top,
          rankings: b.results
            .filter((r) => r.ms.p50 > 0)
            .sort((a, c) => (b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50))
            .map((r) => ({
              name: r.name,
              slug: r.slug,
              ms: r.ms,
              successRate: r.successRate,
            })),
          sparkline: sparklineFor(b, top?.slug),
          headline: headlineSentence(b),
          quote: citationQuote(b, SITE.url),
          pageUrl: `${SITE.url}/benchmarks/${b.slug}`,
          ogImage: `${SITE.url}/api/og/${b.slug}`,
          asOf: b.lastRunAt,
          methodology: b.methodology,
          source: b.source,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      },
    );

    server.registerTool(
      "query_prom",
      {
        title: "Run a PromQL query against the shared Prometheus",
        description:
          "Passthrough to the OpenChainBench Prometheus instance. Use this for queries that don't map to a published benchmark. Caller is responsible for the query semantics. Returns the raw scalar (instant query) or matrix (range query if windowSec is given).",
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(2000)
            .describe("PromQL expression."),
          windowSec: z
            .number()
            .int()
            .positive()
            .max(604_800)
            .optional()
            .describe("If set, run a range query over the last N seconds (max 7 days). Otherwise an instant query."),
          steps: z.number().int().min(2).max(360).optional().describe("Number of samples for a range query. Default 60."),
        },
      },
      async ({ query, windowSec, steps }) => {
        const url = process.env.PROMETHEUS_URL;
        if (!url) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "prometheus_unconfigured" }) }],
            isError: true,
          };
        }
        const prom = new Prometheus(url);
        try {
          if (windowSec) {
            const series = await prom.series(query, windowSec, steps ?? 60);
            return { content: [{ type: "text", text: JSON.stringify({ query, windowSec, series }, null, 2) }] };
          }
          const v = await prom.scalar(query);
          return { content: [{ type: "text", text: JSON.stringify({ query, value: v }) }] };
        } catch (err) {
          console.error("[mcp:query_prom] upstream error", err);
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "upstream_error" }) }],
            isError: true,
          };
        }
      },
    );
  },
  {},
  {
    basePath: "/api/mcp",
    maxDuration: 60,
  },
);

export { handler as GET, handler as POST };
