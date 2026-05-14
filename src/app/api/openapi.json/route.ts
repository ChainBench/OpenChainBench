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
            value: { type: "number", nullable: true },
            headline: { type: "string" },
            url: { type: "string", format: "uri" },
            api: { type: "string", format: "uri" },
            ogImage: { type: "string", format: "uri" },
            asOf: { type: "string", format: "date-time" },
          },
        },
        Stat: {
          type: "object",
          properties: {
            slug: { type: "string" },
            title: { type: "string" },
            value: { type: "number", nullable: true },
            unit: { type: "string" },
            rankings: { type: "array" },
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
