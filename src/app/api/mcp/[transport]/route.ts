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
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * MCP server. Exposes OpenChainBench data to any MCP-capable agent
 * (Claude Desktop, ChatGPT custom tools, generic MCP clients) via three
 * tools that mirror the public REST surface. Streamable-HTTP only — the
 * SSE transport requires Redis which we don't run.
 *
 * Connect at:
 *     https://openchainbench.com/api/mcp/mcp
 */

// Maximum POST body. The MCP handler doesn't enforce a per-request cap;
// we do it before letting the package parse the body.
const MAX_BODY_BYTES = 64 * 1024;

// query_prom allowlist: every metric-like identifier in a query must
// match one of these prefixes. Closes the wallet_balance / up / scrape
// / instance-leak class of exfil attacks via the public MCP endpoint.
// Derived from the metric names declared by current benchmark YAMLs.
const QUERY_PROM_ALLOWED_METRIC_PREFIXES = [
  "head_lag_seconds",
  "bridge_quote_latency_ms",
  "bridge_cost",
  "bridge_fees",
  "bridge_fix_fee",
  "bridge_gas",
  "bridge_output",
  "bridge_estimated_time",
  "bridge_quote_success",
  "l1_finality_",
  "metadata_coverage_",
  "networks_supported",
  "network_coverage_",
  "perp_fees_",
  "wallet_labels_",
];

// PromQL identifiers that are NOT metric names — built-in functions,
// aggregators, modifiers, plus the label names that appear bare in
// selectors. Mirrors the set in src/lib/prometheus.ts plus the labels.
const PROMQL_RESERVED_IDENTS = new Set([
  "sum", "avg", "max", "min", "count", "count_values", "stddev", "stdvar",
  "topk", "bottomk", "group", "quantile",
  "on", "ignoring", "group_left", "group_right", "by", "without", "bool",
  "and", "or", "unless", "offset",
  "rate", "irate", "increase", "delta", "idelta", "deriv", "predict_linear",
  "quantile_over_time", "avg_over_time", "max_over_time", "min_over_time",
  "sum_over_time", "count_over_time", "stddev_over_time", "stdvar_over_time",
  "last_over_time", "present_over_time", "mad_over_time",
  "changes", "resets",
  "histogram_quantile", "histogram_sum", "histogram_count", "histogram_avg",
  "histogram_fraction", "histogram_stddev", "histogram_stdvar",
  "label_replace", "label_join",
  "abs", "floor", "ceil", "round", "exp", "ln", "log2", "log10", "sqrt",
  "clamp_max", "clamp_min", "clamp", "sgn", "sort", "sort_desc",
  "atan", "atanh", "acos", "acosh", "asin", "asinh",
  "cos", "cosh", "sin", "sinh", "tan", "tanh", "deg", "rad",
  "time", "timestamp", "scalar", "vector", "minute", "hour",
  "day_of_month", "day_of_week", "day_of_year", "days_in_month",
  "month", "year",
  "absent", "absent_over_time", "present", "pi",
  // Label names that appear as bare identifiers inside selectors / `by(...)`.
  "le", "chain", "region", "provider", "bridge", "aggregator", "venue",
  "exchange", "asset", "from_chain", "to_chain", "from_token", "to_token",
  "amount_usd", "side", "type", "error_type",
]);

// Whitespace + non-ASCII spacing variants stripped before pattern checks
// so a NBSP / ZWSP between __name__ and the operator can't slip the rules.
const NON_ASCII_WS = new RegExp(
  "[\\s\\u00a0\\u1680\\u2000-\\u200b\\u202f\\u205f\\u3000\\ufeff]+",
  "g",
);

/** Decide whether a public query_prom request is allowed. Two passes:
 *  - Enumeration patterns that would walk the metric catalog / fingerprint
 *    topology, ignoring case-sensitivity tricks via Unicode whitespace.
 *  - Allowlist of metric-name prefixes — every metric-like identifier in
 *    the query must match a published benchmark namespace, otherwise the
 *    query is refused. This is what turns the public MCP from a passthrough
 *    into a sandbox bound to the data the site already serves. */
function isQueryAllowed(q: string): { ok: true } | { ok: false; reason: string } {
  // Length is already capped to 2000 by Zod, but recompute compact form.
  const c = q.replace(NON_ASCII_WS, "");

  // Pattern blocks.
  if (/__name__[=!]~/.test(c)) return { ok: false, reason: "name_regex_blocked" };
  if (c.includes("{}")) return { ok: false, reason: "empty_selector_blocked" };
  if (/__name__="(\.\+|\.\*|\(.+\))"/.test(c)) return { ok: false, reason: "name_catchall_blocked" };
  if (/(__name__|__address__|job|instance|host)(!?~|!="")/.test(c)) {
    return { ok: false, reason: "label_enum_blocked" };
  }
  if (/\b(group|count|sum|avg|min|max|topk|bottomk|stddev|stdvar|quantile)by\(/.test(c)) {
    return { ok: false, reason: "aggregation_by_blocked" };
  }
  if (/\bcount_values\b/.test(q)) return { ok: false, reason: "count_values_blocked" };

  // Metric-name allowlist. Strip string literals first so quoted label
  // VALUES (`aggregator="mobula"`) don't get scanned as identifiers.
  // The double-quote-only form is what PromQL accepts.
  const noStrings = q.replace(/"(?:\\.|[^"\\])*"/g, '""');
  let sawAllowed = false;
  const idents = noStrings.match(/[a-zA-Z_:][a-zA-Z0-9_:]*/g) ?? [];
  for (const id of idents) {
    if (PROMQL_RESERVED_IDENTS.has(id)) continue;
    if (/^\d/.test(id)) continue;
    if (QUERY_PROM_ALLOWED_METRIC_PREFIXES.some((p) => id.startsWith(p))) {
      sawAllowed = true;
      continue;
    }
    return { ok: false, reason: `metric_not_allowlisted:${id}` };
  }
  if (!sawAllowed) return { ok: false, reason: "no_benchmark_metric_referenced" };
  return { ok: true };
}

const mcpHandler = createMcpHandler(
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
        const benches = (await getBenchmarks()).filter((b) => b.editorialStatus === "live");
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
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
            .optional()
            .describe("Chain label value, e.g. 'base' or 'solana'."),
          region: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
            .optional()
            .describe("Region label value, e.g. 'us-east' or 'eu-west'."),
        },
      },
      async ({ slug, chain, region }) => {
        const b = await getBenchmark(slug, { chain, region });
        if (!b || b.editorialStatus !== "live") {
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
        title: "Run a PromQL query against the published benchmark metrics",
        description:
          "Run an instant or range PromQL query, scoped to the metric namespaces OpenChainBench publishes (head_lag_seconds, bridge_*, l1_finality_*, metadata_coverage_*, network_coverage_*, networks_supported, perp_fees_*, wallet_labels_*). Queries that reach outside this namespace are rejected.",
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(2000)
            .describe("PromQL expression referencing published benchmark metrics."),
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
        const verdict = isQueryAllowed(query);
        if (!verdict.ok) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "query_refused", reason: verdict.reason }) }],
            isError: true,
          };
        }
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
  // The mcp-handler package supports `disableSse` at runtime but its
  // TypeScript types don't declare it (as of 1.1.0). Cast keeps the
  // option set so SSE GETs return 404 instead of hanging while waiting
  // for a Redis we don't run.
  { disableSse: true } as unknown as Record<string, never>,
  {
    basePath: "/api/mcp",
    maxDuration: 60,
  },
);

/** Per-IP rate limit at the transport level. The MCP handler is a single
 *  endpoint for all tool calls, so this bucket caps total MCP RPS for a
 *  given IP. A JSON-RPC batch in a single POST counts only once — we also
 *  reject batches explicitly (see below). */
function rateLimited(req: Request): Response | null {
  const key = clientKey(req, "mcp");
  const r = rateLimit(key, 60, 60);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);
  return null;
}

/** Reject JSON-RPC batch requests — they're an MCP-spec feature but our
 *  per-request rate limit charges 1 token for the whole batch, so a client
 *  posting `[{call1}, {call2}, ..., {callN}]` could otherwise multiply
 *  effective throughput by N. We don't need batching for any documented use
 *  case (tools are independent), so refuse rather than account for them. */
async function rejectBatchOrTooBig(req: Request): Promise<{ response?: Response; cloned: Request }> {
  // Only inspect the body on POST. GET requests don't have one.
  if (req.method !== "POST") return { cloned: req };

  const cl = Number(req.headers.get("content-length") ?? 0);
  if (cl > MAX_BODY_BYTES) {
    return {
      response: new Response(JSON.stringify({ error: "body_too_large" }), {
        status: 413,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }),
      cloned: req,
    };
  }

  // Clone so we can read the body once for inspection, then hand the
  // clone to the MCP handler.
  const cloned = req.clone();
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { cloned };
  }
  if (text.length > MAX_BODY_BYTES) {
    return {
      response: new Response(JSON.stringify({ error: "body_too_large" }), {
        status: 413,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }),
      cloned,
    };
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[")) {
    return {
      response: new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32600, message: "JSON-RPC batch is not supported" },
          id: null,
        }),
        { status: 400, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      ),
      cloned,
    };
  }
  return { cloned };
}

async function wrapped(req: Request): Promise<Response> {
  const limited = rateLimited(req);
  if (limited) return limited;
  const { response, cloned } = await rejectBatchOrTooBig(req);
  if (response) return response;
  return mcpHandler(cloned);
}

export { wrapped as GET, wrapped as POST };
