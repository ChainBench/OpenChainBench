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
      version: "1.0.0",
      description: SITE.description,
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
          ],
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Stat" } } },
            },
            "404": { description: "Unknown slug" },
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
            // OpenAPI 3.1 / JSON Schema 2020-12: use multi-type array
            // for nullable. The 3.0 `nullable: true` keyword is no
            // longer recognised under 3.1.
            value: { type: ["number", "null"] },
            headline: { type: "string" },
            url: { type: "string", format: "uri" },
            api: { type: "string", format: "uri" },
            ogImage: { type: "string", format: "uri" },
            asOf: { type: "string", format: "date-time" },
          },
        },
        Ranking: {
          type: "object",
          properties: {
            name: { type: "string" },
            slug: { type: "string" },
            ms: {
              type: "object",
              properties: {
                p50: { type: "number" },
                p90: { type: "number" },
                p99: { type: "number" },
                mean: { type: "number" },
              },
            },
            successRate: { type: "number" },
            sampleSize: { type: ["integer", "null"] },
            sampleHealth: { type: ["number", "null"] },
            dataConfidence: { type: ["string", "null"], enum: ["healthy", "low", "insufficient", null] },
          },
        },
        Stat: {
          type: "object",
          properties: {
            slug: { type: "string" },
            title: { type: "string" },
            value: { type: ["number", "null"] },
            unit: { type: "string" },
            rankings: {
              type: "array",
              items: { $ref: "#/components/schemas/Ranking" },
            },
            sparkline: { type: "array", items: { type: "number" } },
            headline: { type: "string" },
            quote: { type: "string" },
            pageUrl: { type: "string", format: "uri" },
            asOf: { type: "string", format: "date-time" },
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
