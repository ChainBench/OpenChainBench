/**
 * Citation helpers shared between the JSON API and the UI buttons. Single
 * source of truth for the headline sentence and quote string that
 * everyone (LLMs, journalists, ourselves) sees.
 */

import type { Benchmark, ProviderResult } from "@/types/benchmark";
import { liveResults, displayResults } from "@/lib/provider-filters";
import { fmtUnit } from "@/lib/format";

/** Minimum measured success rate (in percent, 0-100) for a provider to
 *  contribute to the headline leader claim. Providers with a real
 *  success measurement below this floor are excluded from citation
 *  candidates because an "unreliable but accurate when it works"
 *  outlier should not top the leaderboard: it misleads AI agents citing
 *  the bench and any human reader glancing at the headline. Benches
 *  whose harness does not emit a `success` query default to 100 in the
 *  load path (see materialize/load.ts), so this guard is a no-op for
 *  freshness / gauge-only benches and only bites where the harness
 *  actually measures polling reliability (gas-estimation, RPC
 *  benches). */
export const LEADER_MIN_SUCCESS_PCT = 50;

/** Provider set used to derive the headline figures. Drops rows whose
 *  per-provider sample-health is "insufficient" (set on the load path
 *  when the bench declares expected_n and the row falls below the 10
 *  percent of expected floor) and rows whose measured success rate
 *  sits below the reliability floor. Those rows can still render in
 *  some surfaces with a soft tag, but they must not contribute to the
 *  leader claim shipped to AI agents and journalists via the citable
 *  APIs. Falls back to the full live pool when every provider is
 *  below the reliability floor so a totally-degraded bench still
 *  reports a best-of-bad-options leader instead of vanishing.
 *
 *  Exported so downstream machine-readable surfaces (`/api/stat`
 *  rankings, `/api/llm-context`, MCP `get_benchmark`, `/api/compare`)
 *  can share the same eligibility rule as `leader()` and stay
 *  internally consistent: a JSON that names Etherscan as leader
 *  should not simultaneously rank Owlracle first in its `rankings`
 *  array. */
export function citationCandidates(b: Benchmark): ProviderResult[] {
  // A row the spec's own rank gate left unranked (`queries.ranked` = 0,
  // shown as Provisional, or a declared unranked member) is published
  // but never a leader: the ledger already skips it, and until this the
  // template ({{best_name}}), /api/stat and the citation did not (Ondo
  // Perps at 0 stddev led perp-funding-stability, 2026-09-21).
  const live = liveResults(b.results).filter((r) => !r.unrankedLabel);
  const reliable = live.filter(
    (r) => (r.successRate ?? 100) >= LEADER_MIN_SUCCESS_PCT,
  );
  // Chain RPC pages do not fall back: crowning a 23 % success endpoint
  // as "the fastest Starknet RPC" in the TL;DR, StatisticalReport and
  // /api/stat is worse than saying nobody cleared the floor.
  const pool =
    reliable.length > 0 ? reliable : rpcChainLabel(b) ? [] : live;
  if (!b.expectedN) return pool;
  return pool.filter((r) => r.dataConfidence !== "insufficient");
}

/** Sorted candidate pool for the machine-readable `rankings` array on
 *  `/api/stat`, MCP, llm-context and any downstream that ranks the
 *  full field. Applies the same reliability + insufficient-sample
 *  filters as `leader()` so a document that names X as leader ranks X
 *  first in its own list. Sort direction honors the bench's
 *  `higherIsBetter` flag.
 *
 *  Ranks on the value alone, deliberately. A bench whose cross-chain
 *  aggregate would otherwise reward an uncontested chain fixes that by
 *  declaring `score_scope: contested_chains` in its spec, which narrows
 *  the value itself (see materialize/load.ts) rather than sorting on a
 *  key the reader cannot see in the column. */
export function rankedCandidates(b: Benchmark): ProviderResult[] {
  return [...citationCandidates(b)].sort((a, c) =>
    b.higherIsBetter ? c.ms.p50 - a.ms.p50 : a.ms.p50 - c.ms.p50,
  );
}

/** Timestamp of the last real measurement, or null when the bench has
 *  no measurement history yet (draft placeholder). Draft benches carry
 *  a wall-clock `lastRunAt` for type safety (Benchmark.lastRunAt is a
 *  non-nullable string), which downstream JSON, JSON-LD and MCP surfaces
 *  would otherwise expose as a real freshness signal to LLM crawlers.
 *  Use this helper on every machine-readable surface.
 *
 *  Accepts any object that carries `status` + `lastRunAt` so the slim
 *  `ProviderAppearance.benchmark` (a Pick of Benchmark) can use it too. */
export function citableAsOf(
  b: Pick<Benchmark, "status" | "lastRunAt">,
): string | null {
  return b.status === "draft" ? null : b.lastRunAt;
}

/** Median value of the benchmark (the field shown in the headline). */
export function fieldValue(b: Benchmark): number | null {
  if (b.status !== "live") return null;
  // Bench-wide aggregate is insufficient: refuse to publish a value
  // (downstream LLM tools and SERP snippets would otherwise quote a
  // number drawn from a wildly undersized field).
  if (b.dataConfidence === "insufficient") return null;
  const sorted = rankedCandidates(b);
  if (sorted.length === 0) return null;
  return sorted[0].ms.p50;
}

/** Who is currently #1 on this benchmark, if any. */
export function leader(b: Benchmark): { name: string; slug: string; value: number } | null {
  if (b.status !== "live") return null;
  if (b.dataConfidence === "insufficient") return null;
  const sorted = rankedCandidates(b);
  if (sorted.length === 0) return null;
  return { name: sorted[0].name, slug: sorted[0].slug, value: sorted[0].ms.p50 };
}

/** Honest window wording per unit. "(p50, 24h)" is only true for latency
 *  style benches; USD revenue and count benches repurpose the p50 slot as
 *  a plain rolling-window figure and percentile wording would mislead. */
function windowSuffix(unit: string, window = "24h"): string {
  if (unit === "usd" || unit === "count") return `(${window})`;
  if (unit === "pct" || unit === "bps") return `(${window} avg)`;
  return `(p50, ${window})`;
}

/** Short factual sentence ready to paste into an article. Templated, no LLM. */
/** "Head lag" reads "head lag" mid-sentence, but "RPC latency", "P/F ratio"
 *  and "VAA finalization" keep their acronym: only a leading capital
 *  followed by a lowercase letter is lowered. */
export function metricInSentence(metric: string): string {
  return /^[A-Z][a-z]/.test(metric) ? metric[0].toLowerCase() + metric.slice(1) : metric;
}

/** "Arbitrum" for a chain RPC bench (slug <chain>-rpc, category RPCs),
 *  read from the title patterns the cluster uses; null elsewhere. */
export function rpcChainLabel(b: Pick<Benchmark, "slug" | "category" | "title">): string | null {
  if (b.category !== "RPCs" || !b.slug.endsWith("-rpc") || b.slug === "mev-protect-rpc") return null;
  const m = b.title.match(/free ([A-Za-z0-9 .-]+?) RPC/i) ?? b.title.match(/^([A-Za-z0-9 .-]+?) RPC endpoints/i);
  return m ? m[1] : null;
}

/** The access cohort a Benchmark object holds when it is not the bench's
 *  headline one (the keyed RPC variant), else null. Read from the rows:
 *  every row of one object shares the active tier. */
export function nonHeadlineTier(
  b: Pick<Benchmark, "results" | "dimensions" | "aggregateFilters">,
): string | null {
  const tiers = b.dimensions?.tier ?? [];
  if (tiers.length === 0) return null;
  const own = b.results.find((r) => r.tier)?.tier;
  if (!own) return null;
  const headline = b.aggregateFilters?.tier ?? tiers[0].value;
  return own === headline ? null : own;
}

/** Canonical page path for a Benchmark object: the clean URL for the
 *  headline cohort, `?tier=<t>` for another cohort, so every citation
 *  URL (quote, grounding trace, cite bundle, /api/stat pageUrl) points
 *  at the tab that ranks the rows it quotes. */
export function benchPath(
  b: Pick<Benchmark, "slug" | "results" | "dimensions" | "aggregateFilters">,
): string {
  const tier = nonHeadlineTier(b);
  return `/benchmarks/${b.slug}${tier ? `?tier=${tier}` : ""}`;
}

export function headlineSentence(b: Benchmark): string {
  const parts = headlineParts(b);
  return parts.claim ? `${parts.claim} ${parts.rest}` : parts.rest;
}

/** The headline sentence split in two: the leader claim ("GNS posts the
 *  lowest p/f ratio at 1.559x"), which the social cards highlight, and
 *  the qualifier that follows ("(p50, 24h) on <title>."). `claim` is
 *  empty when there is no leader to assert. Joined with one space they
 *  are exactly `headlineSentence`. */
export function headlineParts(b: Benchmark): { claim: string; rest: string } {
  if (b.dataConfidence === "insufficient") {
    return { claim: "", rest: `${b.title}. Insufficient data to assert a leader.` };
  }
  const top = leader(b);
  const chainForFloor = rpcChainLabel(b);
  if (!top && chainForFloor && liveResults(b.results).length > 0) {
    return {
      claim: "",
      rest: `${b.title}. No ${chainForFloor} endpoint answered above the ${LEADER_MIN_SUCCESS_PCT} % success floor in the last 24h.`,
    };
  }
  if (!top) return { claim: "", rest: `${b.title}. Awaiting first run.` };
  const value = fmtUnit(top.value, b.unit);
  // Chain RPC pages: the sentence names the entity searchers use ("free
  // public Arbitrum RPC endpoints") and the cohort size, instead of
  // jamming the H1 in as the object. Same string feeds the TL;DR,
  // StatisticalReport, TechArticle, /api/citable and llms.txt.
  const chain = rpcChainLabel(b);
  if (chain) {
    // Same set as the Results table and the endpoints block (display
    // floor), so the four surfaces quote one count.
    const listed = displayResults(b.results).length;
    const ranked = rankedCandidates(b).length;
    const below = listed - ranked;
    // The keyed variant of a chain page names its cohort: "API-key
    // Arbitrum RPC endpoints", never "free public".
    const cohort = nonHeadlineTier(b) === "keyed" ? "private (API-key)" : "free public";
    const claim =
      ranked === 1 && listed === 1
        ? `${top.name} is the only ${cohort} ${chain} RPC endpoint measured, at ${value}`
        : ranked === 1
          ? `${top.name} is the only one of the ${listed} ${cohort} ${chain} RPC endpoints measured above the ${LEADER_MIN_SUCCESS_PCT} % success floor, at ${value}`
          : `${top.name} has the lowest median latency of the ${ranked} ${cohort} ${chain} RPC endpoints measured${below > 0 ? ` above the ${LEADER_MIN_SUCCESS_PCT} % success floor (${listed} listed)` : ""}, ${value}`;
    return { claim, rest: `(p50, 24h, 3 regions).` };
  }
  const verb = b.higherIsBetter ? "leads" : "posts the lowest";
  return {
    claim: `${top.name} ${verb} ${metricInSentence(b.metric)} at ${value}`,
    rest: `${windowSuffix(b.unit, b.window ?? "24h")} on ${b.title}.`,
  };
}

/** Pasteable attribution string. Standard convention: "<sentence> Source: OpenChainBench (url)". */
export function citationQuote(b: Benchmark, origin: string): string {
  const sentence = headlineSentence(b);
  return `${sentence} Source: OpenChainBench (${origin}${benchPath(b)}).`;
}

/**
 * Canonical "grounding trace" line for LLM extraction. Shipped in three
 * places so a single wording lands everywhere a model, a journalist or a
 * SERP snippet may quote:
 *   1. Visible <p> under the bench H1 (see /benchmarks/[slug]/page.tsx).
 *   2. StatisticalReport JSON-LD description field.
 *   3. /api/llm-context (unchanged, still consumes headlineSentence).
 *
 * Pattern matches what Perplexity, ChatGPT-with-web and Claude cite
 * verbatim: an ISO date anchor, the leader claim, and a "Source:" tail
 * with the exact page URL so the crawler keeps attribution stable when
 * excerpting. Skips the "As of" prefix and the Source tail when the
 * bench has no leader (insufficient / awaiting), because a dated
 * grounding trace with no measurable claim reads like a broken quote to
 * a language model and gets down-weighted.
 */
export function groundingTraceLine(
  b: Benchmark,
  origin: string,
  now: Date = new Date(),
): string {
  const sentence = headlineSentence(b);
  if (b.dataConfidence === "insufficient" || !leader(b)) return sentence;
  // Date the claim by the DATA timestamp (lastRunAt), not render time:
  // a stale bench used to say "As of <today>" on yesterday's numbers,
  // silently masking staleness for answer engines. Render time is only
  // the fallback when the blob carries no timestamp.
  const dataMs = Date.parse(b.lastRunAt ?? "");
  const isoDate = (Number.isFinite(dataMs) ? new Date(dataMs) : now)
    .toISOString()
    .slice(0, 10);
  const url = `${origin}${benchPath(b)}`;
  return `As of ${isoDate}, ${trimTrailingPeriod(sentence)}. Source: OpenChainBench, ${url}.`;
}

/** Structured components of the grounding trace, so a JSX renderer can
 *  wrap the ISO date in a <time dateTime> element while keeping the rest
 *  of the sentence as plain text. Both this helper and
 *  `groundingTraceLine` derive from the same `headlineSentence` +
 *  `leader` primitives so the visible <p>, the schema.org description
 *  and any downstream JSON blob stay word for word identical. Returns
 *  null when the bench has no defensible leader (draft, insufficient,
 *  awaiting): callers should fall back to the plain headline sentence
 *  for those states. */
export type GroundingTraceParts = {
  isoDate: string;
  claim: string;
  url: string;
};

export function groundingTraceParts(
  b: Benchmark,
  origin: string,
  now: Date = new Date(),
): GroundingTraceParts | null {
  if (b.dataConfidence === "insufficient" || !leader(b)) return null;
  const sentence = headlineSentence(b);
  // Same data-timestamp rule as groundingTraceLine above.
  const dataMs = Date.parse(b.lastRunAt ?? "");
  return {
    isoDate: (Number.isFinite(dataMs) ? new Date(dataMs) : now)
      .toISOString()
      .slice(0, 10),
    claim: trimTrailingPeriod(sentence),
    url: `${origin}${benchPath(b)}`,
  };
}

function trimTrailingPeriod(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

/** Pre-formatted citation strings (Plain / BibTeX / APA) for the page
 *  `<CiteBlock>` and the public JSON endpoints. Computed server-side so
 *  the same canonical wording lands in HTML, in the API, and in whatever
 *  an LLM scrapes. Date is computed from the current request time and
 *  spelled out in ISO so journalists and BibTeX both stay happy. */
export type CiteBundle = {
  plain: string;
  bibtex: string;
  apa: string;
  /** RIS record (Research Information Systems) for Zotero, EndNote,
   *  Mendeley and every academic reference manager that speaks the
   *  format. Same fields as bibtex, RIS field codes: TY (type),
   *  AU (author), TI (title), PY (year), UR (url), Y2 (retrieved
   *  date), ER (end record). Type GEN is the neutral fallback for a
   *  dataset citation — RIS has no "benchmark" type. */
  ris: string;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function citeBundle(
  b: Pick<Benchmark, "slug" | "title"> & Partial<Pick<Benchmark, "results" | "dimensions" | "aggregateFilters">>,
  origin: string,
  now: Date = new Date(),
): CiteBundle {
  const url = `${origin}${b.results ? benchPath({ slug: b.slug, results: b.results, dimensions: b.dimensions, aggregateFilters: b.aggregateFilters }) : `/benchmarks/${b.slug}`}`;
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const isoDate = `${yyyy}-${mm}-${dd}`;
  const longDate = `${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}, ${yyyy}`;
  const bibKey = `ocb_${b.slug.replace(/-/g, "_")}`;
  return {
    plain: `OpenChainBench. "${b.title}". Retrieved ${isoDate}. ${url}`,
    bibtex: `@misc{${bibKey},\n  author = {OpenChainBench},\n  title  = {${b.title}},\n  year   = {${yyyy}},\n  url    = {${url}},\n  note   = {Retrieved ${isoDate}}\n}`,
    apa: `OpenChainBench. (${yyyy}). ${b.title}. Retrieved ${longDate}, from ${url}`,
    // RIS records use CRLF line endings by convention (RFC-style),
    // which every consumer we've tested (Zotero 6+, EndNote 20+,
    // Mendeley) accepts either way — using \r\n stays safe.
    ris:
      `TY  - GEN\r\n` +
      `AU  - OpenChainBench\r\n` +
      `TI  - ${b.title}\r\n` +
      `PY  - ${yyyy}\r\n` +
      `UR  - ${url}\r\n` +
      `Y2  - ${isoDate}\r\n` +
      `ER  - \r\n`,
  };
}

/** Compact sparkline (last N points, 24h) for the JSON payload. */
export function sparklineFor(b: Benchmark, providerSlug?: string): number[] {
  const series = b.extras.series24h ?? {};
  const pick = providerSlug && series[providerSlug] ? series[providerSlug] : firstSeries(series);
  // Dense series carry nulls for empty Prom buckets; the citation JSON
  // sparkline stays a plain number array for external consumers.
  return (pick ?? []).filter((v): v is number => v != null);
}

function firstSeries(
  s: Record<string, (number | null)[]>,
): (number | null)[] | null {
  for (const k of Object.keys(s)) {
    const v = s[k];
    if (v && v.length > 0) return v;
  }
  return null;
}

/** Structural subset accepted by `isInsufficient`. Lets the hub card
 *  call this with the slim BenchmarkCardData shape (which omits the
 *  full Benchmark fields the predicate does not read) without breaking
 *  the existing full-Benchmark call sites. */
export type InsufficientCheckInput = {
  editorialStatus: Benchmark["editorialStatus"];
  status: Benchmark["status"];
  results: { ms: { p50: number }; availability?: "live" | "unavailable" }[];
};

/** Lightweight predicate used by hub cards + machine-readable APIs to
 *  decide whether a benchmark should be hidden from leader assertions.
 *  Stricter than the `dataConfidence === "insufficient"` check (which
 *  requires the spec to declare expected_n): also catches editorial
 *  draft state and the cold-start "no live providers" case where the
 *  aggregator returned a placeholder. */
export function isInsufficient(b: InsufficientCheckInput): boolean {
  if (b.editorialStatus !== "live") return true;
  if (b.status !== "live") return true;
  // Note: do NOT key on b.sampleSize === 0. The aggregator loader can
  // fall back to a draft placeholder with sampleSize=0 even when the
  // per-bench loader holds real data, which mass-flagged 25 of 26
  // benches as insufficient on /api/citable while /api/stat returned
  // live values for the same slug. The liveResults length and p50
  // finiteness checks below already catch the genuine empty case.
  // Use isFinite rather than > 0 so deviation benches (where a negative
  // p50 is valid data, e.g. rwa-yield-accuracy reporting -6 bps) are not
  // mis-classified as insufficient.
  const live = b.results.filter(
    (r) => r.availability !== "unavailable" && Number.isFinite(r.ms.p50) && r.ms.p50 !== 0,
  );
  if (live.length === 0) return true;
  return live.every((r) => !Number.isFinite(r.ms.p50));
}
