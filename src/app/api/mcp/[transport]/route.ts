import { createMcpHandler } from "mcp-handler";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBenchmark, getBenchmarks } from "@/data/benchmarks";
import { SITE } from "@/data/site";
import {
  benchPath,
  citableAsOf,
  citationQuote,
  cohortSummaries,
  fieldValue,
  headlineSentence,
  isInsufficient,
  leader,
  rankedCandidates,
  sparklineFor,
} from "@/lib/citation";
import { answerOneLine, loadRenderedAnswers } from "@/lib/answers-rendered";
import { benchMarkdown } from "@/lib/markdown-views";
import { valueInDeclaredUnit } from "@/lib/format";
import {
  compactRow,
  compareOnBenchmark,
  matchUseCase,
  searchBenchmarks,
} from "@/lib/mcp-tools";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * MCP server. Exposes OpenChainBench data to any MCP-capable agent
 * (Claude Desktop, ChatGPT apps, generic MCP clients). Streamable-HTTP only
 * - the SSE transport requires Redis which we don't run.
 *
 * Connect at:
 *     https://openchainbench.com/api/mcp/mcp
 *
 * The tools are shaped by the questions people ask, not by the REST surface
 * they used to mirror, because a client routes on the description text: a
 * tool called "list_benchmarks" is never going to match "which Solana RPC
 * should I use". So `search_benchmarks` takes the user's own words,
 * `compare_providers` takes the names they said, and `recommend_provider`
 * takes the goal they stated. `get_benchmark` remains the way to open one
 * bench in full once you know its slug.
 *
 * Two deliberate removals:
 *   - `query_prom` took raw PromQL. Behind an allowlist it was safe enough
 *     for a developer tool, but no end user asks for a PromQL passthrough,
 *     it was attack surface with no reader, and every extra tool dilutes the
 *     routing the useful ones depend on. Agents that want arbitrary series
 *     can still query Prometheus directly; the site does not proxy it.
 *   - `list_benchmarks` no longer returns the catalogue. It served all 229
 *     live benches in one response, 142,534 characters, about 35,600 tokens,
 *     for questions as broad as "what do you measure". It is now compact,
 *     capped and filterable.
 *
 * Values cross this boundary in the unit the bench declares, via
 * `valueInDeclaredUnit`. Latency benches declaring `unit: "s"` store
 * milliseconds internally, and this endpoint used to publish the stored
 * number: {"value":443.494,"unit":"s"} for a head lag the site and
 * /api/stat both render as 0.44 s. Same bug the REST route fixed earlier;
 * it was never carried across.
 */

// Maximum POST body. The MCP handler doesn't enforce a per-request cap;
// we do it before letting the package parse the body.
const MAX_BODY_BYTES = 64 * 1024;

const mcpHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_benchmarks",
      {
        title: "Browse the benchmark catalogue",
        description: [
          "A compact index of what OpenChainBench measures. One short row per",
          "benchmark: slug, title, category, the metric, the current value and",
          "who leads it.",
          "",
          "Use when the user asks what is measured at all (\"what does",
          "OpenChainBench cover?\", \"do you track bridges?\"). When they ask a",
          "question about a provider or a chain, use `search_benchmarks` instead:",
          "it ranks the catalogue against their words and costs far less to read.",
          "",
          "The catalogue holds over 200 benchmarks, so this is capped and",
          "filterable rather than exhaustive. Narrow with `category`, then open",
          "the one you need with `get_benchmark`.",
          "",
          "Categories: RPCs, Trading, Bridges, Blockchains, Aggregators, RWA, NFT APIs.",
        ].join("\n"),
        inputSchema: {
          category: z
            .string()
            .max(40)
            .optional()
            .describe("Only this category: RPCs, Trading, Bridges, Blockchains, Aggregators, RWA or NFT APIs."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("How many rows to return, 1 to 50. Default 25."),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ category, limit }) => {
        const benches = (await getBenchmarks()).filter((b) => b.editorialStatus === "live");
        const cat = category?.trim().toLowerCase();
        const pool = cat ? benches.filter((b) => b.category.toLowerCase() === cat) : benches;
        const capped = pool.slice(0, Math.min(Math.max(limit ?? 25, 1), 50));
        const rows = capped.map((b) => compactRow(b, SITE.url));
        const payload = {
          returned: rows.length,
          totalMatching: pool.length,
          totalLive: benches.length,
          ...(cat ? { category } : {}),
          note:
            pool.length > rows.length
              ? `Showing ${rows.length} of ${pool.length}. Narrow with category, or use search_benchmarks with the user's own words.`
              : undefined,
          benchmarks: rows,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      },
    );

    server.registerTool(
      "search_benchmarks",
      {
        title: "Find the benchmark that answers a question",
        description: [
          "Ranks the benchmark catalogue against a question in the user's own",
          "words and returns the best few matches.",
          "",
          "Use this when somebody asks which provider, chain or service is",
          "fastest, cheapest, most reliable or best for something. Pass their",
          "phrasing through: provider names, chain names and goals all match.",
          "",
          "  • \"which Solana RPC is fastest\"      -> search_benchmarks({ query: \"solana rpc\" })",
          "  • \"Alchemy or QuickNode on Base?\"    -> search_benchmarks({ query: \"alchemy quicknode base\" })",
          "  • \"cheapest way to bridge to Arbitrum\" -> search_benchmarks({ query: \"bridge arbitrum\" })",
          "",
          "Returns compact rows. Open the one you want with `get_benchmark` for",
          "the full ranking and a citation line. An empty result means nothing",
          "is measured for that question; say so rather than guessing.",
        ].join("\n"),
        inputSchema: {
          query: z
            .string()
            .min(1)
            .max(200)
            .describe("The user's question or keywords, verbatim. Provider and chain names work well."),
          category: z
            .string()
            .max(40)
            .optional()
            .describe("Optional category filter: RPCs, Trading, Bridges, Blockchains, Aggregators, RWA, NFT APIs."),
          limit: z.number().int().min(1).max(25).optional().describe("How many matches, 1 to 25. Default 8."),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ query, category, limit }) => {
        const benches = (await getBenchmarks()).filter((b) => b.editorialStatus === "live");
        const matches = searchBenchmarks(benches, {
          query,
          category,
          limit: limit ?? 8,
          siteUrl: SITE.url,
        });
        const payload = {
          query,
          count: matches.length,
          matches,
          ...(matches.length === 0
            ? { note: "Nothing in the catalogue matches. OpenChainBench may not measure this; do not infer a winner." }
            : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
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
          "Chain RPC benchmarks (<chain>-rpc) rank two access cohorts apart:",
          "the free public endpoints (default) and the private, API-key",
          "providers (Alchemy, Chainstack, GetBlock, QuickNode). The default response",
          "carries both under `cohorts`; pass tier=\"keyed\" to get the private",
          "cohort as the main record (rankings, quote, pageUrl). Never compare a",
          "public row with a private row: they are measured on different",
          "endpoints and cadences.",
          "",
          "Example usage:",
          "  • User: \"who's the fastest crypto data aggregator on Base?\"",
          "    → get_benchmark({ slug: \"aggregator-head-lag\", chain: \"base\" })",
          "  • User: \"how much does it cost to bridge $300 cross-chain?\"",
          "    → get_benchmark({ slug: \"bridge-fee\" })",
          "  • User: \"fastest Base RPC with an API key, Alchemy or QuickNode?\"",
          "    → get_benchmark({ slug: \"base-rpc\", tier: \"keyed\" })",
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
          tier: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
            .optional()
            .describe("Optional access cohort on chain RPC benchmarks: 'public' (default, free no-key endpoints) or 'keyed' (private, API-key providers). Only honored when the bench declares tier dimensions."),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ slug, chain, region, tier }) => {
        const aggregate = await getBenchmark(slug);
        // Tier resolves against the declared values; the headline tier is
        // the aggregate itself (no separate variant).
        const tierOption = tier
          ? aggregate?.dimensions?.tier?.find((t) => t.value.toLowerCase() === tier.toLowerCase())
          : undefined;
        if (tier && !tierOption) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "unknown_tier", slug, tier, declared: aggregate?.dimensions?.tier?.map((t) => t.value) ?? [] }) }],
            isError: true,
          };
        }
        const headlineTier = aggregate?.aggregateFilters?.tier ?? aggregate?.dimensions?.tier?.[0]?.value;
        const tierFilter = tierOption && tierOption.value !== headlineTier ? tierOption.value : undefined;
        const b = await getBenchmark(slug, { chain, region, tier: tierFilter });
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
        // `ms` is the stored field and keeps its name; `value` beside it is
        // the same number in the bench's declared unit, so a caller reading
        // either one is right.
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
              value: r.ms.p50 == null ? null : valueInDeclaredUnit(r.ms.p50, b.unit),
              successRate: r.successRate,
            }));
        // Latency benches declaring unit "s" store milliseconds (the fmtUnit
        // convention in format.ts). /api/stat has converted on the way out
        // since that bug was found there; this endpoint never did, and served
        // {"value":443.494,"unit":"s"} for a head lag the site renders 0.44 s.
        const raw = insufficient ? null : fieldValue(b);
        const payload = {
          slug: b.slug,
          title: b.title,
          metric: b.metric,
          unit: b.unit,
          status,
          value: raw == null ? null : valueInDeclaredUnit(raw, b.unit),
          leader: top == null ? null : { ...top, value: valueInDeclaredUnit(top.value, b.unit) },
          rankings,
          sparkline: insufficient ? [] : sparklineFor(b, top?.slug),
          headline: headlineSentence(b),
          quote: citationQuote(b, SITE.url),
          pageUrl: `${SITE.url}${benchPath(b)}`,
          ogImage: `${SITE.url}/api/og/${b.slug}`,
          asOf: citableAsOf(b),
          methodology: b.methodology,
          source: b.source,
          ...(cohortSummaries(b, SITE.url).length > 0 ? { cohorts: cohortSummaries(b, SITE.url) } : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      },
    );

    server.registerTool(
      "compare_providers",
      {
        title: "Compare named providers head to head",
        description: [
          "Puts two or more named providers side by side on one benchmark, with",
          "each one's rank, measured value and success rate.",
          "",
          "Use when the user names the candidates themselves: \"Alchemy or",
          "QuickNode?\", \"is Helius faster than Triton for Solana?\", \"compare",
          "Across and Stargate on fees\".",
          "",
          "Find the benchmark slug with `search_benchmarks` first if you do not",
          "already have it. Providers the benchmark does not measure come back",
          "in `missing`: say they are not measured rather than implying they",
          "ranked badly. A provider measured but below the ranking floor comes",
          "back with rank null, which is also not a loss.",
        ].join("\n"),
        inputSchema: {
          benchmark: z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]{0,79}$/)
            .describe("Benchmark slug, e.g. 'solana-rpc' or 'bridge-fee'. Get it from search_benchmarks."),
          providers: z
            .array(z.string().min(1).max(60))
            .min(2)
            .max(10)
            .describe("Two to ten provider names or slugs, as the user said them, e.g. ['Alchemy', 'QuickNode']."),
          chain: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).optional().describe("Optional chain slice when the bench declares chains."),
          region: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).optional().describe("Optional region slice when the bench declares regions."),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ benchmark, providers, chain, region }) => {
        const b = await getBenchmark(benchmark, { chain, region });
        if (!b || b.editorialStatus !== "live") {
          const payload = { error: "unknown_slug", slug: benchmark };
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
            isError: true,
          };
        }
        const comparison = compareOnBenchmark(b, providers, SITE.url);
        const payload = {
          ...comparison,
          title: b.title,
          headline: headlineSentence(b),
          quote: citationQuote(b, SITE.url),
          lowerIsBetter: !b.higherIsBetter,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      },
    );

    server.registerTool(
      "recommend_provider",
      {
        title: "Recommend a provider for a stated use case",
        description: [
          "Answers \"which should I use for X\" by picking the benchmarks that",
          "measure X and reporting who currently leads them.",
          "",
          "Pass the user's goal in their own words: \"a Solana trading bot\", \"an",
          "indexer backfilling Base\", \"a wallet that needs price data\", \"bridging",
          "to Arbitrum\".",
          "",
          "This returns measurements and the caveat that goes with them, not an",
          "endorsement. A leader on one benchmark is the leader of that one",
          "measurement over its stated window. Where the use case has a known",
          "caveat (a bot should read p99 rather than p50, an indexer is bound by",
          "archive depth) it comes back in `guidance`; pass it on, it is usually",
          "more useful than the ranking itself.",
        ].join("\n"),
        inputSchema: {
          use_case: z
            .string()
            .min(2)
            .max(200)
            .describe("What the user is building or doing, in their words. e.g. 'solana trading bot', 'indexer', 'price feed for a wallet'."),
          chain: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
            .optional()
            .describe("Chain they are building on, e.g. 'solana', 'base', 'arbitrum'. Narrows the benchmarks considerably."),
          region: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).optional().describe("Optional region, e.g. 'eu-west', when latency from a location matters."),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ use_case, chain, region }) => {
        const benches = (await getBenchmarks()).filter((b) => b.editorialStatus === "live");
        const uc = matchUseCase(use_case);
        // The chain is the strongest signal when present, so it leads the
        // query; the use case words follow and break ties.
        const query = [chain ?? "", use_case].join(" ").trim();
        const matches = searchBenchmarks(benches, {
          query,
          category: uc?.category,
          limit: 5,
          siteUrl: SITE.url,
        });

        const detailed = await Promise.all(
          matches.slice(0, 3).map(async (m) => {
            const full = await getBenchmark(m.slug, { chain, region });
            if (!full || full.editorialStatus !== "live") return null;
            const top = isInsufficient(full) ? null : leader(full);
            return {
              benchmark: full.slug,
              title: full.title,
              metric: full.metric,
              unit: full.unit,
              leader: top == null ? null : { ...top, value: valueInDeclaredUnit(top.value, full.unit) },
              headline: headlineSentence(full),
              quote: citationQuote(full, SITE.url),
              url: `${SITE.url}${benchPath(full)}`,
              asOf: citableAsOf(full),
            };
          }),
        );

        const payload = {
          useCase: use_case,
          ...(chain ? { chain } : {}),
          recognisedAs: uc?.id ?? null,
          guidance:
            uc?.why ??
            "No specific guidance for this use case; the benchmarks below are the closest matches by wording.",
          caveat:
            "These are measurements over a stated window, not endorsements. Check the window and the sample size on the page before relying on a ranking.",
          benchmarks: detailed.filter((d) => d !== null),
          alsoRelevant: matches.slice(3),
          ...(matches.length === 0
            ? { note: "Nothing in the catalogue matches this use case; do not infer a recommendation." }
            : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      },
    );

    server.registerTool(
      "list_answers",
      {
        title: "List OpenChainBench answer pages",
        description: [
          "Returns every published answer page: one plain question, the sentence that",
          "answers it from live data, and the benchmark the number comes from.",
          "",
          "Call this when the user asks a question in words rather than by benchmark",
          "name (\"which bridge is cheapest for $300?\", \"which Solana RPC lands",
          "transactions fastest?\"). Match the question, then call `get_benchmark` with",
          "the returned `benchmark` slug for the full ranking behind it.",
          "",
          "Returns one row per answer:",
          "  { slug, question, answer, benchmark, chain?, url, benchmarkUrl }",
          "",
          "Cite `url` when the question itself is the claim, `benchmarkUrl` when the",
          "measurement is. Drafts are filtered out, and an answer whose benchmark has",
          "no defensible leader yet says so in `answer` rather than naming a winner.",
        ].join("\n"),
        inputSchema: {
          benchmark: z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]{0,79}$/)
            .optional()
            .describe("Optional benchmark slug filter: return only the answers built on that bench."),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ benchmark }) => {
        const all = await loadRenderedAnswers();
        const rows = (benchmark ? all.filter((a) => a.benchmark === benchmark) : all).map((a) => ({
          slug: a.slug,
          question: a.question,
          answer: answerOneLine(a),
          benchmark: a.benchmark,
          ...(a.chain ? { chain: a.chain } : {}),
          url: a.url,
          benchmarkUrl: `${SITE.url}/benchmarks/${a.benchmark}`,
        }));
        const payload = { count: rows.length, answers: rows };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
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

        const md = benchMarkdown(b);

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
            { uri: uri.href, mimeType: "text/markdown", text: md },
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
