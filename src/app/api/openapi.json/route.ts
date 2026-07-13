import { NextResponse } from "next/server";
import { SITE } from "@/data/site";

export const runtime = "nodejs";
export const revalidate = 3600;

/**
 * Minimal OpenAPI 3.1 description so agent frameworks (LangChain,
 * LlamaIndex, OpenAI custom GPTs, generic MCP clients) can discover
 * and consume the API without hand-wiring schemas.
 */
export async function GET() {
  const doc = {
    openapi: "3.1.0",
    info: {
      title: "OpenChainBench API",
      version: "1.1.0",
      description: `${SITE.description} An MCP server (Streamable HTTP, POST only) is also available at ${SITE.url}/api/mcp/mcp exposing list_benchmarks, get_benchmark and query_prom tools; see ${SITE.url}/mcp for install instructions.`,
      license: { name: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
    },
    servers: [{ url: SITE.url }],
    paths: {
      "/api/citable": {
        get: {
          summary: "Flat index of every citable benchmark with current values.",
          operationId: "list_benchmarks",
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/CitableIndex" } } },
            },
          },
        },
      },
      "/api/citable/{date}": {
        get: {
          summary:
            "Immutable per-day snapshot of the citable index. Same shape as /api/citable; values freeze at end-of-day for past dates. Lets citers pin a citation to a stable URL that keeps returning the number they quoted.",
          operationId: "list_benchmarks_snapshot",
          parameters: [
            {
              name: "date",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              description: "ISO 8601 calendar date (YYYY-MM-DD).",
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/CitableIndex" } } },
            },
            "400": { description: "Malformed or out-of-range date" },
            "503": { description: "Benchmarks temporarily unavailable" },
          },
        },
      },
      "/api/stat/{slug}": {
        get: {
          summary: "Single benchmark with rankings, sparkline, and a ready-to-paste citation.",
          operationId: "get_benchmark",
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Benchmark slug (e.g. 'aggregator-head-lag').",
            },
            {
              name: "chain",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "Restrict the response to a specific chain dimension (e.g. 'ethereum'). Unknown values 404.",
            },
            {
              name: "region",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "Restrict the response to a specific region dimension (e.g. 'us-east'). Unknown values 404.",
            },
            {
              name: "kind",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "Restrict the response to a specific bench-defined `kind` dimension when the spec declares one.",
            },
            {
              name: "venue",
              in: "query",
              required: false,
              schema: { type: "string" },
              description:
                "Restrict the response to a specific bench-defined `venue` dimension when the spec declares one.",
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Stat" } } },
            },
            "404": { description: "Unknown slug or unknown dimension value" },
          },
        },
      },
      "/api/compare/{a}/{b}": {
        get: {
          summary:
            "Head-to-head comparison of two providers on every benchmark where they both appear. One tool call resolves an X-vs-Y query end to end instead of two /api/stat lookups plus reasoning across them.",
          operationId: "compare_providers",
          parameters: [
            {
              name: "a",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Provider slug for the left side of the comparison.",
            },
            {
              name: "b",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Provider slug for the right side of the comparison.",
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Compare" },
                },
              },
            },
            "400": { description: "Malformed or identical provider slugs" },
            "404": { description: "One of the providers or no shared benchmark" },
          },
        },
      },
      "/api/og/{slug}": {
        get: {
          summary: "Watermarked 1200×630 PNG showing the current value and sparkline.",
          operationId: "get_og_image",
          parameters: [
            { name: "slug", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "PNG", content: { "image/png": {} } },
            "404": { description: "Unknown slug" },
          },
        },
      },
      "/api/llm-context": {
        get: {
          summary:
            "All benchmarks, rankings and methodology as one Markdown document, ready to paste into a system prompt.",
          operationId: "get_llm_context",
          responses: {
            "200": {
              description: "OK",
              content: { "text/markdown": { schema: { type: "string" } } },
            },
            "503": { description: "Benchmarks temporarily unavailable" },
          },
        },
      },
      "/api/freshness": {
        get: {
          summary:
            "Lightweight freshness probe: last resolved data timestamp (epoch ms) per benchmark slug.",
          operationId: "get_freshness",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Freshness" },
                },
              },
            },
          },
        },
      },
      "/api/search/featured": {
        get: {
          summary:
            "Slim featured-leaders payload (live leaders + trending benches) that feeds the site search dialog.",
          operationId: "get_featured_leaders",
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        CitableIndex: {
          type: "object",
          properties: {
            site: { type: "object" },
            count: { type: "integer" },
            benchmarks: { type: "array", items: { $ref: "#/components/schemas/CitableRow" } },
          },
        },
        CitableRow: {
          type: "object",
          properties: {
            slug: { type: "string" },
            title: { type: "string" },
            metric: { type: "string" },
            unit: { type: "string" },
            value: {
              type: "number",
              nullable: true,
              description: "Current leading value, expressed in `unit`.",
            },
            headline: { type: "string" },
            url: { type: "string", format: "uri" },
            api: { type: "string", format: "uri" },
            ogImage: { type: "string", format: "uri" },
            asOf: { type: "string", format: "date-time" },
          },
        },
        Freshness: {
          type: "object",
          properties: {
            now: { type: "integer", description: "Server epoch ms at response time." },
            freshness: {
              type: "object",
              additionalProperties: { type: "integer" },
              description: "Benchmark slug to last data timestamp (epoch ms).",
            },
          },
        },
        Stat: {
          type: "object",
          properties: {
            slug: { type: "string" },
            title: { type: "string" },
            value: {
              type: "number",
              nullable: true,
              description: "Current leading value, expressed in `unit`.",
            },
            unit: { type: "string" },
            filters: {
              type: "object",
              nullable: true,
              description:
                "Echo of the applied dimension filter (chain, region, kind, venue) when the request scoped the response to a sub-cell; null when the response is the cross-dimension aggregate.",
              properties: {
                chain: { type: "string" },
                region: { type: "string" },
                kind: { type: "string" },
                venue: { type: "string" },
              },
            },
            rankings: { type: "array" },
            sparkline: { type: "array", items: { type: "number" } },
            headline: { type: "string" },
            quote: { type: "string" },
            pageUrl: { type: "string", format: "uri" },
            asOf: {
              type: "string",
              format: "date-time",
              nullable: true,
              description:
                "Last measurement timestamp. Null when the bench has no live samples yet (draft state).",
            },
          },
        },
        Compare: {
          type: "object",
          properties: {
            a: {
              type: "object",
              description: "Left side of the head-to-head.",
              properties: {
                slug: { type: "string" },
                name: { type: "string" },
              },
            },
            b: {
              type: "object",
              description: "Right side of the head-to-head.",
              properties: {
                slug: { type: "string" },
                name: { type: "string" },
              },
            },
            totalWins: {
              type: "object",
              description:
                "Head-to-head win tally across the shared benchmark set. Sum of a + b + tie equals shared.length.",
              properties: {
                a: { type: "integer" },
                b: { type: "integer" },
                tie: { type: "integer" },
              },
            },
            shared: {
              type: "array",
              description:
                "Per benchmark head-to-head rows for every bench where both providers appear. Each row publishes p50 for each side in the declared unit, which side is faster on the metric's higher-is-better convention, and the numeric delta.",
              items: {
                type: "object",
                properties: {
                  slug: { type: "string" },
                  title: { type: "string" },
                  metric: { type: "string" },
                  unit: { type: "string" },
                  higherIsBetter: { type: "boolean" },
                  aValue: { type: "number", nullable: true },
                  bValue: { type: "number", nullable: true },
                  winner: {
                    type: "string",
                    enum: ["a", "b", "tie"],
                    description: "Which side wins on this benchmark.",
                  },
                  delta: {
                    type: "number",
                    nullable: true,
                    description:
                      "Absolute difference between aValue and bValue in the declared unit. Positive means a > b regardless of the higher-is-better convention.",
                  },
                  pageUrl: { type: "string", format: "uri" },
                  asOf: {
                    type: "string",
                    format: "date-time",
                    nullable: true,
                  },
                },
              },
            },
            comparePageUrl: {
              type: "string",
              format: "uri",
              description:
                "Canonical HTML comparison page (openchainbench.com/compare/{a}-vs-{b}) with the full leaderboard tables.",
            },
          },
        },
      },
    },
  };

  return NextResponse.json(doc, {
    headers: {
      "cache-control": "public, s-maxage=3600",
      "access-control-allow-origin": "*",
    },
  });
}
