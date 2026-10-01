import { valueInDeclaredUnit } from "@/lib/format";
import { citableAsOf, fieldValue, headlineSentence, isInsufficient, leader, rankedCandidates } from "@/lib/citation";
import type { Benchmark } from "@/types/benchmark";

/**
 * Shaping for the MCP tools, kept out of the route so it can be tested
 * without standing up a server.
 *
 * Three things this file exists to get right, all of them learned by
 * measuring the live endpoint rather than by reading the code:
 *
 * 1. `list_benchmarks` returned every live bench in one response: 229 rows,
 *    142,534 characters, about 35,600 tokens, for a question as broad as
 *    "which RPC is fastest". A model handed that spends its context on JSON
 *    instead of on the answer. `compactRow` is the index shape (nine short
 *    fields) and `searchBenchmarks` returns a ranked handful instead of the
 *    whole catalogue.
 *
 * 2. The MCP tools published `fieldValue(b)` straight, which is the stored
 *    value. Latency benches declaring `unit: "s"` store milliseconds by
 *    convention (see fmtUnit in format.ts), so the endpoint served
 *    {"value":443.494,"unit":"s"} for a head lag the site and /api/stat both
 *    render as 0.44 s: a thousandfold error under provider names, on three
 *    benches including number 001. `valueInDeclaredUnit` already existed for
 *    exactly this reason and /api/stat already used it; the MCP server never
 *    did. Every value crossing this boundary goes through `declared()`.
 *
 * 3. Tool routing is driven by the description text, so the catalogue needs
 *    a vocabulary a user would actually type. `USE_CASES` maps the words
 *    people use ("trading bot", "indexer") onto categories and benchmark
 *    slugs, so `recommend_provider` can answer a question phrased as a goal
 *    rather than as a benchmark name.
 */

/** Value in the unit the bench declares, never the stored one. */
function declared(value: number | null | undefined, unit: string): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return valueInDeclaredUnit(value, unit);
}

export type CompactRow = {
  slug: string;
  title: string;
  category: string;
  metric: string;
  unit: string;
  value: number | null;
  leader: string | null;
  url: string;
  asOf: string | null;
};

/**
 * One index row. Deliberately nine short fields: enough for a model to pick
 * which bench to open, small enough that a page of them costs little. The
 * full record, with rankings and the citation quote, is `get_benchmark`.
 */
export function compactRow(b: Benchmark, siteUrl: string): CompactRow {
  const insufficient = isInsufficient(b);
  const top = insufficient ? null : leader(b);
  return {
    slug: b.slug,
    title: b.title,
    category: b.category,
    metric: b.metric,
    unit: b.unit,
    value: insufficient ? null : declared(fieldValue(b), b.unit),
    leader: top?.name ?? null,
    url: `${siteUrl}/benchmarks/${b.slug}`,
    asOf: citableAsOf(b),
  };
}

/** Words that carry no signal in a benchmark query. */
const STOP = new Set([
  "the", "a", "an", "is", "are", "was", "for", "of", "to", "in", "on", "at", "by",
  "what", "which", "who", "whats", "best", "good", "me", "my", "i", "should", "use",
  "and", "or", "with", "from", "most", "more", "than", "that", "this", "it", "its",
  "do", "does", "can", "how", "much", "many", "get", "give", "show", "tell", "find",
]);

/** Words a user types that mean "rank ascending" on a cost or latency bench. */
const SUPERLATIVES = new Set(["fastest", "cheapest", "lowest", "quickest", "best", "fast", "cheap", "low"]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Haystack for one bench: what somebody might type to mean it. Provider
 * names are in here deliberately, so "is Alchemy or QuickNode faster on
 * Base" finds the Base RPC bench without the user knowing its slug.
 */
function haystack(b: Benchmark): string[] {
  const providers = b.results.slice(0, 40).flatMap((r) => [r.name, r.slug]);
  return tokens([b.slug, b.title, b.category, b.metric, ...providers].join(" "));
}

/**
 * Deterministic token overlap rather than a fuzzy library: the ranking has
 * to be explainable when a user asks why a bench came up, and reproducible
 * in a test. A slug match is worth most because it is unambiguous; a
 * superlative matches nothing on its own (every latency bench would tie)
 * and is dropped before scoring.
 */
export function scoreBenchmark(b: Benchmark, query: string): number {
  const q = tokens(query).filter((t) => !SUPERLATIVES.has(t));
  if (q.length === 0) return 0;
  const hay = new Set(haystack(b));
  const slugTokens = new Set(tokens(b.slug));
  const titleTokens = new Set(tokens(b.title));

  let score = 0;
  for (const t of q) {
    if (slugTokens.has(t)) score += 4;
    else if (titleTokens.has(t)) score += 2;
    else if (hay.has(t)) score += 1;
    // Prefix match catches "solana" against "solana-rpc" and "arb" against
    // "arbitrum", which exact token overlap misses.
    else if ([...hay].some((h) => h.startsWith(t) || t.startsWith(h))) score += 0.5;
  }
  // Normalise by query length so a two-word query is comparable to a long
  // sentence; otherwise a rambling question beats a precise one.
  return score / q.length;
}


/**
 * Minimum score for a match to be published.
 *
 * A slug token is worth 4 and a provider name 1, so a real question clears
 * this easily ("solana rpc" scores 4, "helius triton" scores 1). What it cuts
 * is prefix-only noise: "buy SOL for me" matched buyback-audit and three
 * Solana benches at 0.5, on nothing but the first three letters. Returning
 * those invites a model to treat them as relevant.
 */
const MIN_SCORE = 1;

/**
 * Redact anything secret-shaped before echoing a query back.
 *
 * The search echo is useful (the model should see what it searched) but it is
 * also a reflection: asked "test my RPC with my API key abc123SECRET", the
 * endpoint returned the secret inside its own payload. Nothing persists it,
 * yet it still reaches the model's context and the client's logs, and the
 * rule here is that a key never appears in any of those.
 *
 * Deliberately blunt. Over-redacting a benchmark query costs a reader
 * nothing; under-redacting a live credential costs them the credential.
 */
export function redactSecrets(text: string): string {
  return text
    // key=value and bearer forms
    .replace(/\b(api[-_ ]?key|apikey|token|secret|bearer|password|pwd)\b\s*[:=]?\s*\S+/gi, "$1 [redacted]")
    // bare high-entropy runs: 16+ chars mixing letters and digits
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    // anything that looks like a keyed endpoint
    .replace(/https?:\/\/\S+/gi, "[redacted-url]");
}

export type SearchResult = CompactRow & { score: number };

/**
 * Ranked benchmarks for a natural-language query. Returns a handful, not the
 * catalogue: the caller then opens the ones it needs with `get_benchmark`.
 */
export function searchBenchmarks(
  benches: Benchmark[],
  opts: { query?: string; category?: string; limit?: number; siteUrl: string },
): SearchResult[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const category = opts.category?.trim().toLowerCase();
  const pool = category
    ? benches.filter((b) => b.category.toLowerCase() === category)
    : benches;

  // No query: the category listing, newest data first, still capped.
  if (!opts.query?.trim()) {
    return pool.slice(0, limit).map((b) => ({ ...compactRow(b, opts.siteUrl), score: 0 }));
  }

  const scored = pool
    .map((b) => ({ b, score: scoreBenchmark(b, opts.query as string) }))
    .filter((x) => x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.b.slug.localeCompare(b.b.slug))
    .slice(0, limit);

  return scored.map(({ b, score }) => ({ ...compactRow(b, opts.siteUrl), score: Math.round(score * 100) / 100 }));
}

/**
 * The goals people state, mapped onto what the catalogue actually measures.
 *
 * This is the bridge between "I'm building a trading bot" and a benchmark
 * slug. Keep the keys as the words a user types, not as internal vocabulary:
 * the tool description tells the model to pass the user's own phrasing
 * through, so the match has to happen on their words.
 */
export const USE_CASES: { id: string; matches: string[]; category: string; prefer: string[]; why: string }[] = [
  {
    id: "rpc",
    matches: ["rpc", "node", "endpoint", "json-rpc", "archive", "dapp", "wallet", "web3"],
    category: "RPCs",
    prefer: ["-rpc"],
    why: "RPC benchmarks measure call latency and availability per chain, split by public endpoints and keyed providers.",
  },
  {
    id: "trading-bot",
    matches: ["bot", "trading bot", "mev", "arbitrage", "sniper", "latency-sensitive", "hft"],
    category: "RPCs",
    prefer: ["-rpc"],
    why: "A bot is bound by tail latency and landing rate, so read p99 rather than p50, and prefer the keyed cohort.",
  },
  {
    id: "indexer",
    matches: ["indexer", "indexing", "backfill", "historical", "archive node", "subgraph"],
    category: "RPCs",
    prefer: ["-rpc"],
    why: "Indexing is dominated by archive-depth support and sustained throughput rather than single-call latency.",
  },
  {
    id: "price-feed",
    matches: ["price", "price feed", "market data", "quotes", "ticker", "aggregator", "ohlcv"],
    category: "Aggregators",
    prefer: ["aggregator-head-lag"],
    why: "Head lag measures the delay between a swap landing on chain and the provider publishing it.",
  },
  {
    id: "bridge",
    matches: ["bridge", "cross-chain", "cross chain", "transfer", "bridging"],
    category: "Bridges",
    prefer: ["bridge-fee", "bridge-quote-latency"],
    why: "Bridges are compared on realised cost and on quote latency; the two rank differently.",
  },
  {
    id: "perp",
    matches: ["perp", "perps", "perpetual", "futures", "leverage", "funding"],
    category: "Trading",
    prefer: ["perp-fees"],
    why: "Perp venues are compared on all-in cost per trade, which includes fees and slippage, not the advertised fee alone.",
  },
];

/** The use case a phrase names, or null when nothing matches. */
export function matchUseCase(text: string): (typeof USE_CASES)[number] | null {
  const t = text.toLowerCase();
  let best: (typeof USE_CASES)[number] | null = null;
  let bestLen = 0;
  for (const uc of USE_CASES) {
    for (const m of uc.matches) {
      // Longest phrase wins: "trading bot" must beat "bot", and both must
      // beat a bare "rpc" appearing elsewhere in the sentence.
      if (t.includes(m) && m.length > bestLen) {
        best = uc;
        bestLen = m.length;
      }
    }
  }
  return best;
}

export type ProviderComparison = {
  benchmark: string;
  metric: string;
  unit: string;
  asOf: string | null;
  url: string;
  rows: { name: string; slug: string; rank: number | null; value: number | null; successRate: number | null; found: boolean }[];
  missing: string[];
};

/**
 * Head-to-head rows for named providers on one benchmark.
 *
 * Providers the bench does not measure come back in `missing` rather than
 * being dropped: "we do not measure Infura on this bench" and "Infura ranks
 * last" are different answers, and silently returning the second when the
 * first is true is how a comparison tool starts lying.
 */
export function compareOnBenchmark(b: Benchmark, providers: string[], siteUrl: string): ProviderComparison {
  const ranked = isInsufficient(b) ? [] : rankedCandidates(b);
  const wanted = providers.map((p) => p.trim().toLowerCase()).filter(Boolean);
  const rows: ProviderComparison["rows"] = [];
  const missing: string[] = [];

  for (const want of wanted) {
    const idx = ranked.findIndex(
      (r) => r.slug.toLowerCase() === want || r.name.toLowerCase() === want,
    );
    if (idx === -1) {
      const anywhere = b.results.find(
        (r) => r.slug.toLowerCase() === want || r.name.toLowerCase() === want,
      );
      if (anywhere) {
        // Measured, but below the ranking floor: say so rather than ranking it.
        rows.push({
          name: anywhere.name,
          slug: anywhere.slug,
          rank: null,
          value: null,
          successRate: anywhere.successRate ?? null,
          found: true,
        });
      } else {
        missing.push(want);
      }
      continue;
    }
    const r = ranked[idx];
    rows.push({
      name: r.name,
      slug: r.slug,
      rank: idx + 1,
      value: declared(r.ms.p50, b.unit),
      successRate: r.successRate ?? null,
      found: true,
    });
  }

  return {
    benchmark: b.slug,
    metric: b.metric,
    unit: b.unit,
    asOf: citableAsOf(b),
    url: `${siteUrl}/benchmarks/${b.slug}`,
    rows,
    missing,
  };
}

/** The sentence a tool returns above its data, so the model has something to
 *  say without reading the whole payload first. */
export function summaryLine(b: Benchmark): string {
  return headlineSentence(b);
}
