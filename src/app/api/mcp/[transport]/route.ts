import { createMcpHandler } from "mcp-handler";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBenchmark, getBenchmarks } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import {
  citableAsOf,
  citationQuote,
  fieldValue,
  headlineSentence,
  isInsufficient,
  leader,
  rankedCandidates,
  sparklineFor,
} from "@/lib/citation";
import { fmtUnit } from "@/lib/format";
import { Prometheus } from "@/lib/prometheus";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * MCP server. Exposes OpenChainBench data to any MCP-capable agent
 * (Claude Desktop, ChatGPT custom tools, generic MCP clients) via three
 * tools that mirror the public REST surface. Streamable-HTTP only - the
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
  // Aggregator latency / head-lag
  "head_lag_seconds",
  // Bridge benches (bridge-fee + bridge-quote-latency)
  "bridge_quote_latency_ms",
  "bridge_cost",
  "bridge_fees",
  "bridge_fix_fee",
  "bridge_gas",
  "bridge_output",
  "bridge_estimated_time",
  "bridge_quote_success",
  // L1 finality + L2 block time
  "l1_finality_",
  "l2_block_time_",
  // Metadata + network + wallet coverage
  "metadata_coverage_",
  "metadata_api_latency_",
  "networks_supported",
  "network_coverage_",
  "wallet_labels_",
  // PM freshness bench
  "pm_",
  // EVM swap quote latency bench (#033)
  "evm_swap_quote_",
  // Perp fees + funding + venue KPIs + execution scanner + buyback + oracle + validator yield
  "perp_fees_",
  "perp_funding_",
  "perp_venue_",
  "perp_execution_",
  "ocb_buyback_",
  "ocb_oracle_",
  "ocb_validator_",
  "ocb_chain_",
  // Gas oracle prediction accuracy
  "gas_error_",
  "gas_predicted_",
  "gas_realized_",
  "gas_oracle_",
  // Stablecoin peg (+ usdt-anchored variant)
  "peg_",
  // Solana TX landing (observational + active)
  "solana_landing_",
  // Public RPC capabilities
  "rpc_latency_",
  "rpc_call_total",
  "rpc_health",
  "rpc_archive_depth_supported",
  // Bridge revenue (Relay-style implied margin)
  "relay_",
  "per_swap_margin_usd",
  // Hyperliquid frontends quality bench (bench № 030)
  "hl_frontend_",
];

// PromQL identifiers that are NOT metric names - built-in functions,
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
  // PromQL @-modifier anchors (Prom 2.26+): `metric @ start()` / `@ end()`.
  "start", "end", "step",
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
 *  - Allowlist of metric-name prefixes - every metric-like identifier in
 *    the query must match a published benchmark namespace, otherwise the
 *    query is refused. This is what turns the public MCP from a passthrough
 *    into a sandbox bound to the data the site already serves. */
function isQueryAllowed(q: string): { ok: true } | { ok: false; reason: string } {
  // Strip PromQL `#` comments first so a comment like `# wallet_balance`
  // doesn't tip the allowlist. PromQL comments run to end-of-line.
  const noComments = q.replace(/#[^\n]*/g, "");
  // Strip string literals so quoted label VALUES (`aggregator="mobula"`)
  // never get scanned as identifiers - they're attacker-controlled text,
  // but PromQL escapes their content via Prom's parser, not our regex.
  const stripped = noComments.replace(/"(?:\\.|[^"\\])*"/g, '""');
  // Whitespace-normalised form. Used for every pattern check so a NBSP
  // between operator and operand can't slip a rule.
  const c = stripped.replace(NON_ASCII_WS, "");

  // Pattern blocks - all operate on `c`, the comment+string-stripped,
  // whitespace-normalised form.
  if (/__name__[=!]~/.test(c)) return { ok: false, reason: "name_regex_blocked" };
  if (c.includes("{}")) return { ok: false, reason: "empty_selector_blocked" };
  if (/__name__="(\.\+|\.\*|\(.+\))"/.test(c)) return { ok: false, reason: "name_catchall_blocked" };
  if (/(__name__|__address__|job|instance|host)(!?~|!="")/.test(c)) {
    return { ok: false, reason: "label_enum_blocked" };
  }
  // Aggregation by (instance|host|__name__|__address__|job) reveals
  // topology labels we don't publish. `by (le)` is fine - it's how
  // every histogram_quantile query in our specs is shaped.
  if (
    /\b(group|count|sum|avg|min|max|topk|bottomk|stddev|stdvar|quantile)by\((__name__|__address__|job|instance|host)\b/.test(
      c,
    )
  ) {
    return { ok: false, reason: "topology_aggregation_blocked" };
  }
  if (/\bcount_values\b/.test(c)) return { ok: false, reason: "count_values_blocked" };

  // Metric-name allowlist - every identifier-like token outside strings,
  // comments, AND range-vector durations must match a published benchmark
  // namespace. Strip `[5m]` / `[24h]` / `[7d]` etc. so the `h`/`m`/`d`/`s`
  // suffix letters aren't scanned as identifiers.
  const noDurations = stripped.replace(/\[\s*\d+\s*(?:ms|s|m|h|d|w|y)\s*\]/g, "[]");
  let sawAllowed = false;
  const idents = noDurations.match(/[a-zA-Z_:][a-zA-Z0-9_:]*/g) ?? [];
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
        title: "List OpenChainBench benchmarks",
        description: [
          "Returns a flat index of every published OpenChainBench benchmark with its",
          "current headline value, leader, category, units, and citation URL.",
          "",
          "Call this first when the user asks a discovery question like",
          "\"what benchmarks does OpenChainBench have?\" or \"compare crypto aggregators\".",
          "Then use `get_benchmark` for the specific slug(s) the answer needs.",
          "",
          "Returns one line per bench:",
          "  { slug, title, category, metric, unit, value, leader, headline, url, asOf }",
          "",
          "Drafts are filtered out: only live benchmarks appear.",
        ].join("\n"),
        inputSchema: {},
      },
      async () => {
        const benches = (await getBenchmarks()).filter((b) => b.editorialStatus === "live");
        const rows = benches.map((b) => {
          const insufficient = isInsufficient(b);
          const top = insufficient ? null : leader(b);
          const status: "live" | "draft" | "insufficient" = insufficient
            ? "insufficient"
            : b.status;
          return {
            slug: b.slug,
            title: b.title,
            category: b.category,
            metric: b.metric,
            unit: b.unit,
            status,
            value: insufficient ? null : fieldValue(b),
            leader: top,
            headline: headlineSentence(b),
            url: `${SITE.url}/benchmarks/${b.slug}`,
            asOf: citableAsOf(b),
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
        title: "Get a single OpenChainBench benchmark",
        description: [
          "Returns full detail for one benchmark, ready to cite verbatim:",
          "  • rankings (every provider sorted by p50)",
          "  • sparkline (24h trend, 72 points)",
          "  • headline sentence + paste-ready citation quote",
          "  • methodology bullets + source-code URL + canonical pageUrl + OG image URL",
          "",
          "Pass `chain` and/or `region` to scope the result to a sub-slice when",
          "the benchmark declares those dimensions (e.g. aggregator-head-lag",
          "exposes chain=base|bnb|solana, region=us-east|eu-west|ap-southeast).",
          "Both args are optional; omit them for the global aggregate.",
          "",
          "Example usage:",
          "  • User: \"who's the fastest crypto data aggregator on Base?\"",
          "    → get_benchmark({ slug: \"aggregator-head-lag\", chain: \"base\" })",
          "  • User: \"how much does it cost to bridge $300 cross-chain?\"",
          "    → get_benchmark({ slug: \"bridge-fee\" })",
          "",
          "Drafts return { error: \"unknown_slug\" }. Cite the returned `pageUrl`",
          "and use `quote` as the attribution line in your answer.",
        ].join("\n"),
        inputSchema: {
          slug: z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]{0,79}$/)
            .describe("Benchmark slug from list_benchmarks. e.g. 'aggregator-head-lag', 'bridge-quote-latency', 'l1-finality'."),
          chain: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
            .optional()
            .describe("Optional chain filter, e.g. 'base', 'solana', 'bnb'. Only honored when the bench declares chain dimensions."),
          region: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
            .optional()
            .describe("Optional region filter, e.g. 'us-east', 'eu-west', 'ap-southeast'. Only honored when the bench declares region dimensions."),
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
        const insufficient = isInsufficient(b);
        const top = insufficient ? null : leader(b);
        const status: "live" | "draft" | "insufficient" = insufficient
          ? "insufficient"
          : b.status;
        const rankings = insufficient
          ? b.results.map((r) => ({
              name: r.name,
              slug: r.slug,
              ms: { p50: null, p90: null, p99: null, mean: null },
              successRate: r.successRate,
            }))
          : rankedCandidates(b).map((r) => ({
              name: r.name,
              slug: r.slug,
              ms: r.ms,
              successRate: r.successRate,
            }));
        const payload = {
          slug: b.slug,
          title: b.title,
          metric: b.metric,
          unit: b.unit,
          status,
          value: insufficient ? null : fieldValue(b),
          leader: top,
          rankings,
          sparkline: insufficient ? [] : sparklineFor(b, top?.slug),
          headline: headlineSentence(b),
          quote: citationQuote(b, SITE.url),
          pageUrl: `${SITE.url}/benchmarks/${b.slug}`,
          ogImage: `${SITE.url}/api/og/${b.slug}`,
          asOf: citableAsOf(b),
          methodology: b.methodology,
          source: b.source,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      },
    );

    server.registerTool(
      "query_prom",
      {
        title: "Run a PromQL query (scoped to benchmark metric namespaces)",
        description: [
          "Direct PromQL passthrough for advanced questions that don't map cleanly",
          "to `list_benchmarks` / `get_benchmark`, e.g. \"what was Mobula's p50",
          "head-lag yesterday at 14:00 UTC\" or \"plot bridge fees over the last hour\".",
          "",
          "Prefer the higher-level tools first; reach for this when you need:",
          "  • a custom time window (instant query at a specific point, or range)",
          "  • a derived metric (rates, ratios, deltas)",
          "  • a histogram bucket aggregation across chains/regions",
          "",
          "Allowed metric namespaces (one prefix per OCB bench family):",
          "  head_lag_seconds (aggregator latency)",
          "  bridge_quote_latency_ms*, bridge_cost*, bridge_fees*, bridge_fix_fee*,",
          "    bridge_gas*, bridge_output*, bridge_estimated_time*, bridge_quote_success",
          "  l1_finality_*, l2_block_time_*",
          "  metadata_coverage_*, metadata_api_latency_*, network_coverage_*,",
          "    networks_supported, wallet_labels_*",
          "  perp_fees_*, perp_funding_*, perp_venue_*, perp_execution_*,",
          "  ocb_buyback_*, ocb_oracle_*, ocb_validator_*, ocb_chain_*",
          "  gas_error_*, gas_predicted_*, gas_realized_*, gas_oracle_*",
          "  peg_* (stablecoin peg, both variants)",
          "  solana_landing_* (TX landing observational + active)",
          "  rpc_latency_*, rpc_call_total, rpc_health, rpc_archive_depth_supported",
          "  relay_*, per_swap_margin_usd (bridge revenue)",
          "Queries referencing other metrics (operational/internal ones like `up`,",
          "`scrape_*`, `process_*`, `go_*`, `wallet_balance_*` or any label-",
          "enumeration shape) are refused with `{error, reason}`.",
          "",
          "Example: instant p50 over 1h for Mobula head-lag on Base:",
          "  query_prom({",
          "    query: \"quantile_over_time(0.5, head_lag_seconds{aggregator=\\\"mobula\\\",chain=\\\"base\\\"}[1h]) * 1000\"",
          "  })",
          "",
          "Example: 7-day sparkline of average bridge fees:",
          "  query_prom({",
          "    query: \"avg_over_time(bridge_fees_percent[1d])\",",
          "    windowSec: 604800,",
          "    steps: 168",
          "  })",
          "",
          "Returns: `{ query, value }` for instant queries, `{ query, windowSec, series }` for range.",
        ].join("\n"),
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(2000)
            .describe("PromQL expression referencing published benchmark metric prefixes only. Function names, label keys, and quoted label values are fine; bare metric names must be allowlisted."),
          windowSec: z
            .number()
            .int()
            .positive()
            .max(604_800)
            .optional()
            .describe("If set, run a range query over the last N seconds (max 7 days = 604800). Omit for an instant query."),
          steps: z.number().int().min(2).max(360).optional().describe("Number of samples for a range query (2 to 360). Default 60. Step duration = windowSec / steps."),
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

    // ── Resources ──────────────────────────────────────────────────────
    // Every live benchmark is also exposed as an MCP resource so an agent
    // can pin it into its context as a long-lived document - useful when
    // the user is iterating on the same benchmark across several turns and
    // doesn't want the agent to re-fetch via tool calls each time.
    //
    // URI scheme: `openchainbench://benchmark/<slug>`
    // The same content is also offered at the canonical https:// pageUrl.
    server.registerResource(
      "benchmark",
      new ResourceTemplate("openchainbench://benchmark/{slug}", {
        list: async () => {
          const benches = (await getBenchmarks()).filter((b) => b.editorialStatus === "live");
          return {
            resources: benches.map((b) => ({
              uri: `openchainbench://benchmark/${b.slug}`,
              name: `${b.title} · ${b.category}`,
              description: headlineSentence(b),
              mimeType: "text/markdown",
            })),
          };
        },
      }),
      {
        title: "OpenChainBench benchmark",
        description:
          "A single benchmark rendered as Markdown with live rankings, methodology and citation metadata. Use as long-lived context when reasoning across multiple turns about the same bench.",
        mimeType: "text/markdown",
      },
      async (uri: URL) => {
        const slug = uri.pathname.replace(/^\/?/, "");
        if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify({ error: "bad_slug", slug }),
              },
            ],
          };
        }
        const b = await getBenchmark(slug);
        if (!b || b.editorialStatus !== "live") {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify({ error: "unknown_slug", slug }),
              },
            ],
          };
        }
        const insufficient = isInsufficient(b);
        const top = insufficient ? null : leader(b);
        // Shares `rankedCandidates` with `leader()` so the Markdown
        // Rankings list matches the Headline sentence above and the
        // `rankings` field on the JSON tool response below. Without
        // this, an agent reading this resource would see e.g.
        // "Etherscan leads" then a numbered list with Owlracle at #1.
        const ranked = insufficient ? [] : rankedCandidates(b);

        const md: string[] = [];
        md.push(`# ${b.title}`);
        md.push("");
        md.push(`> ${b.subtitle}`);
        md.push("");
        md.push(`- Category: ${b.category}`);
        md.push(`- Metric: ${b.metric} (${b.unit})`);
        md.push(`- Page: ${SITE.url}/benchmarks/${b.slug}`);
        md.push(`- Source: ${b.source}`);
        md.push(`- License: CC-BY-4.0`);
        {
          const asOf = citableAsOf(b);
          md.push(`- Last sample: ${asOf ?? "(no measurement yet, draft)"}`);
        }
        md.push("");
        md.push(`**Headline.** ${headlineSentence(b)}`);
        md.push("");
        md.push(`**Citation quote.** ${citationQuote(b, SITE.url)}`);
        md.push("");
        if (ranked.length > 0) {
          md.push(`## Rankings (p50, 24h)`);
          md.push("");
          for (let i = 0; i < ranked.length; i++) {
            const r = ranked[i];
            md.push(
              `${i + 1}. **${r.name}**: ${fmtUnit(r.ms.p50, b.unit)} (p99 ${fmtUnit(r.ms.p99, b.unit)}, success ${r.successRate.toFixed(1)}%, sample ${r.sampleSize ?? "n/a"})`,
            );
          }
          md.push("");
        }
        if (b.methodology.length > 0) {
          md.push(`## Methodology`);
          md.push("");
          for (const m of b.methodology) md.push(`- ${m}`);
          md.push("");
        }
        md.push(`---`);
        md.push(`Cite this benchmark: link ${SITE.url}/benchmarks/${b.slug} · JSON ${SITE.url}/api/stat/${b.slug}`);

        // We attach both Markdown (default rendering) and JSON (structured
        // access) so clients can pick whichever matches their context.
        const status: "live" | "draft" | "insufficient" = insufficient
          ? "insufficient"
          : b.status;
        const payload = {
          slug: b.slug,
          title: b.title,
          metric: b.metric,
          unit: b.unit,
          status,
          value: insufficient ? null : fieldValue(b),
          leader: top,
          rankings: insufficient
            ? b.results.map((r) => ({
                name: r.name,
                slug: r.slug,
                ms: { p50: null, p90: null, p99: null, mean: null },
                successRate: r.successRate,
                sampleSize: r.sampleSize ?? null,
              }))
            : ranked.map((r) => ({
                name: r.name,
                slug: r.slug,
                ms: r.ms,
                successRate: r.successRate,
                sampleSize: r.sampleSize,
              })),
          sparkline: insufficient ? [] : sparklineFor(b, top?.slug),
          headline: headlineSentence(b),
          quote: citationQuote(b, SITE.url),
          pageUrl: `${SITE.url}/benchmarks/${b.slug}`,
          asOf: citableAsOf(b),
          methodology: b.methodology,
          source: b.source,
        };
        return {
          contents: [
            { uri: uri.href, mimeType: "text/markdown", text: md.join("\n") },
            { uri: `${uri.href}.json`, mimeType: "application/json", text: JSON.stringify(payload, null, 2) },
          ],
        };
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
 *  given IP. A JSON-RPC batch in a single POST counts only once - we also
 *  reject batches explicitly (see below). */
function rateLimited(req: Request): Response | null {
  const key = clientKey(req, "mcp");
  const r = rateLimit(key, 60, 60, req);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);
  return null;
}

/** Reject JSON-RPC batch requests - they're an MCP-spec feature but our
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
  // SSE short-circuit. `disableSse: true` is set on the handler config
  // but its TypeScript shape is undocumented; this belt-and-suspenders
  // return ensures /api/mcp/sse never reaches the package code that
  // would hang waiting for a Redis we don't run.
  const url = new URL(req.url);
  if (url.pathname === "/api/mcp/sse") {
    return new Response("Not Found", {
      status: 404,
      headers: { "Cache-Control": "public, s-maxage=3600" },
    });
  }

  const limited = rateLimited(req);
  if (limited) return limited;
  const { response, cloned } = await rejectBatchOrTooBig(req);
  if (response) return response;
  return mcpHandler(cloned);
}

export { wrapped as GET, wrapped as POST };
