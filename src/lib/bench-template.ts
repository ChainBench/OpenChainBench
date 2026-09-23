/**
 * Tiny templating layer for editorial text fields on a benchmark
 * (`abstract`, `findings`, `seo_intro`, `faq.q`, `faq.a`).
 *
 * The motivation: editorial text written in the YAML can quote live
 * numbers ("Cardano sits ~6 min at the 15-confirmation depth") that
 * drift over time as the underlying measurement changes. Templating
 * lets a YAML author write the placeholder once and have the renderer
 * substitute the current live value at render time, so the published
 * page never lies.
 *
 * Supported placeholders, all enclosed in `{{ ... }}`:
 *
 *   {{p50:<slug>}}             live p50 for a provider, formatted with
 *                              the benchmark's unit. e.g. "6.6 min" /
 *                              "397 ms".
 *   {{p90:<slug>}}             same for p90.
 *   {{p99:<slug>}}             same for p99.
 *   {{mean:<slug>}}            same for mean.
 *   {{success:<slug>}}         provider success rate, "99.8 %".
 *   {{name:<slug>}}            provider display name.
 *   {{best_names}}          every provider tied with the leader, joined.
 *   {{best_name}}              name of the leading provider (best p50).
 *   {{best_p50}}               p50 of the leader, formatted.
 *   {{worst_name}}             name of the trailing provider.
 *   {{worst_p50}}              p50 of the trailing provider, formatted.
 *   {{best_name:chain:<x>}}    name of the provider that leads on chain
 *                              <x> specifically. Defuses the cross-chain
 *                              aggregate bias (a Solana-only provider
 *                              mechanically winning head-lag because
 *                              Solana slots are sub-second). Requires the
 *                              spec to declare `dimensions.chain`.
 *   {{best_p50:chain:<x>}}     p50 of the per-chain leader, formatted.
 *   {{worst_name:chain:<x>}}   trailing provider on chain <x>.
 *   {{worst_p50:chain:<x>}}    p50 of the trailing provider on chain <x>.
 *   {{best_name:tier:<t>}}     leader of another access cohort on a bench
 *                              that declares `dimensions.tier` (the public
 *                              RPC page quoting its keyed cohort). Reads the
 *                              `tierResults` stash; the active cohort's own
 *                              leader stays {{best_name}}.
 *   {{best_p50:tier:<t>}}      p50 of that cohort's leader, formatted.
 *   {{count:tier:<t>}}         live providers in that cohort.
 *   {{count}}                  number of providers with live data.
 *
 * Per-slug lookups ({{p50:<slug>}}, {{name:<slug>}}...) search the
 * active cohort first and then every other tier's stash, so the public
 * page can quote a keyed provider by slug without a tier prefix.
 *
 * Unknown placeholders are left untouched so a typo in the YAML can't
 * silently erase a sentence. A known placeholder that cannot resolve
 * today (`{{p50:arbitrum-official}}` while that endpoint is down, or
 * `{{best_name}}` before the first run) is different: the token is
 * correct, the data is missing, and a page must not print raw template
 * syntax. The clause that quotes it is dropped instead (clauses are
 * split on `;`, then on the sentence boundary), so "X leads at 44 ms;
 * the chain-official endpoint measures {{p50:foo}}." renders as
 * "X leads at 44 ms." during the outage and recovers on its own.
 */

import type { Benchmark, ProviderResult } from "@/types/benchmark";
import { liveResults, displayResults } from "@/lib/provider-filters";
import { citationCandidates, joinNames, leaderNames, rankedCandidates } from "@/lib/citation";
import { rankResults } from "@/lib/ranking";
import { fmtUnit } from "@/lib/format";

// Keyword allows digits ({{p50:slug}}, {{best_p50}}, {{worst_p99}}) and
// underscores, must start with a letter. The earlier [a-z_]+ form
// silently dropped every percentile placeholder because the `5` in `p50`
// fell outside the character class - the match never anchored, leaving
// the literal `{{p50:slug}}` in the rendered page.
const TEMPLATE_RE = /\{\{\s*([a-z][a-z0-9_]*)(?::([a-z0-9-]+))?\s*\}\}/gi;

// Chain-aware variants. Resolved BEFORE TEMPLATE_RE so the longer form
// gets first dibs; whatever is left falls through to the unfiltered
// resolver. Pattern: {{best_name:chain:solana}}, {{worst_p50:chain:bnb}}.
// Marker left in place of a known-but-unresolvable placeholder, removed
// with its clause by pruneUnresolved(). A control character so no YAML
// author can type it.
const UNRESOLVED = "\u0000";

/** Drop every clause that still carries an UNRESOLVED marker. Sentences
 *  split on `. `, clauses inside a sentence on `; `. A sentence whose
 *  clauses all fall is removed; a sentence that keeps some ends in a
 *  period again. Text with no marker is returned untouched. */
export function pruneUnresolved(text: string): string {
  if (text.indexOf(UNRESOLVED) === -1) return text;
  return text
    .split(/\n/)
    .map((line) => {
      if (line.indexOf(UNRESOLVED) === -1) return line;
      const sentences = line.split(/(?<=[.!?])\s+/);
      const kept: string[] = [];
      for (const sentence of sentences) {
        if (sentence.indexOf(UNRESOLVED) === -1) {
          kept.push(sentence);
          continue;
        }
        const end = /[.!?]$/.exec(sentence)?.[0] ?? ".";
        const clauses = sentence
          .replace(/[.!?]$/, "")
          .split(/;\s*/)
          .filter((c) => c.indexOf(UNRESOLVED) === -1 && c.trim() !== "");
        if (clauses.length === 0) continue;
        kept.push(clauses.join("; ") + end);
      }
      return kept.join(" ");
    })
    .join("\n");
}

const CHAIN_TEMPLATE_RE =
  /\{\{\s*(best_name|best_p50|worst_name|worst_p50):chain:([a-z0-9_-]+)\s*\}\}/gi;
const TIER_TEMPLATE_RE =
  /\{\{\s*(best_name|best_p50|worst_name|worst_p50|count):tier:([a-z0-9_-]+)\s*\}\}/gi;

/** Ranked live rows of another tier cohort (see Benchmark.tierResults),
 *  or the active cohort itself (`own`, already ranked with the citation
 *  floor) when `tier` names it: a spec author can then write
 *  {{best_name:tier:public}} in copy shared by both tabs. */
function tierRows(b: Benchmark, tier: string, own: ProviderResult[]): ProviderResult[] {
  const lower = tier.toLowerCase();
  const ownTier = b.results.find((r) => r.tier)?.tier;
  if (ownTier && ownTier.toLowerCase() === lower) return own;
  const stash = b.tierResults ?? {};
  const key = Object.keys(stash).find((k) => k.toLowerCase() === lower);
  if (!key) return [];
  // Same gate as the headline cohort (success floor, Provisional rows
  // never lead): rank the stash as if it were the bench's results. No
  // ungated fallback: a cohort with no citable row yields no leader, and
  // the clause quoting it is pruned, like the keyed tab that names nobody.
  const cohort: Benchmark = { ...b, results: stash[key] };
  return rankResults(citationCandidates(cohort), b.higherIsBetter);
}

/** Per-chain leader / trailer lookups against the Benchmark stash
 *  populated by spec.ts. Inlined (not re-imported from spec.ts) to
 *  avoid a spec.ts → bench-template.ts → spec.ts circular import.
 *
 *  Case-insensitive lookup: the stash is keyed by the raw YAML value
 *  (`spec.dimensions.chain[*].value`), which authors write as either
 *  `solana` or `BTC` depending on convention. Without the fold,
 *  `{{best_p50:chain:BTC}}` on perp-fees (uppercase asset codes) misses
 *  a stash whose only entry is keyed `BTC`, because the template
 *  resolver lowercases `chain` before lookup.
 */
function findChainEntry<T>(
  stash: Record<string, T> | undefined,
  chain: string,
): T | undefined {
  if (!stash) return undefined;
  const direct = stash[chain];
  if (direct) return direct;
  const lower = chain.toLowerCase();
  for (const [k, v] of Object.entries(stash)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
function bestForChain(b: Benchmark, chain: string): ProviderResult | undefined {
  return findChainEntry(b.bestPerChain, chain);
}
function worstForChain(b: Benchmark, chain: string): ProviderResult | undefined {
  return findChainEntry(b.worstPerChain, chain);
}

export function renderTemplate(text: string, benchmark: Benchmark): string {
  if (!text || text.indexOf("{{") === -1) return text;
  // `live` still drives per-slug lookups so callers of {{p50:some-slug}}
  // can still address unreliable providers by name (the token is
  // explicit). `bestPool` applies the same reliability floor as
  // `leader()` so {{best_name}} and {{best_p50}} tokens in bench copy
  // never elevate a provider that would be filtered out of the
  // citation headline.
  const live = liveResults(benchmark.results);
  const bestPool = citationCandidates(benchmark);
  const sorted = rankResults(
    bestPool.length > 0 ? bestPool : live,
    benchmark.higherIsBetter,
  );
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  // Resolve chain-scoped placeholders first so they don't fall through to
  // the unfiltered resolver as unknown tokens.
  const withChain = text.replace(
    CHAIN_TEMPLATE_RE,
    (whole, keyword: string, chain: string) => {
      const k = keyword.toLowerCase();
      if (k === "best_name") {
        const lead = bestForChain(benchmark, chain);
        return lead ? lead.name : UNRESOLVED;
      }
      if (k === "best_p50") {
        const lead = bestForChain(benchmark, chain);
        return lead ? fmtUnit(lead.ms.p50, benchmark.unit) : UNRESOLVED;
      }
      if (k === "worst_name") {
        const trailer = worstForChain(benchmark, chain);
        return trailer ? trailer.name : UNRESOLVED;
      }
      if (k === "worst_p50") {
        const trailer = worstForChain(benchmark, chain);
        return trailer ? fmtUnit(trailer.ms.p50, benchmark.unit) : UNRESOLVED;
      }
      return whole;
    },
  );

  const withTier = withChain.replace(
    TIER_TEMPLATE_RE,
    (whole, keyword: string, tier: string) => {
      const k = keyword.toLowerCase();
      const rows = tierRows(benchmark, tier, sorted);
      if (k === "count") return rows.length > 0 ? String(rows.length) : UNRESOLVED;
      const lead = rows[0];
      const trailer = rows[rows.length - 1];
      if (k === "best_name") return lead ? lead.name : UNRESOLVED;
      if (k === "best_p50") return lead ? fmtUnit(lead.ms.p50, benchmark.unit) : UNRESOLVED;
      if (k === "worst_name") return trailer ? trailer.name : UNRESOLVED;
      if (k === "worst_p50") return trailer ? fmtUnit(trailer.ms.p50, benchmark.unit) : UNRESOLVED;
      return whole;
    },
  );
  // Per-slug lookups reach every cohort: the active one first.
  const otherTierRows = Object.values(benchmark.tierResults ?? {}).flatMap((rows) =>
    liveResults(rows),
  );

  const rendered = withTier.replace(TEMPLATE_RE, (whole, keyword: string, arg?: string) => {
    const k = keyword.toLowerCase();
    switch (k) {
      case "p50":
      case "p90":
      case "p99":
      case "mean":
      case "success":
      case "name": {
        if (!arg) return whole;
        const provider =
          live.find((r) => r.slug.toLowerCase() === arg.toLowerCase()) ??
          otherTierRows.find((r) => r.slug.toLowerCase() === arg.toLowerCase());
        if (!provider) return UNRESOLVED;
        if (k === "name") return provider.name;
        if (k === "success") {
          return `${provider.successRate.toFixed(1).replace(/\.0$/, "")} %`;
        }
        const raw = provider.ms[k as "p50" | "p90" | "p99" | "mean"];
        return fmtUnit(raw, benchmark.unit);
      }
      case "best_name": {
        // One name, so the 600 authored sentences built around a singular
        // subject keep their grammar; a display tie is marked instead of
        // hidden, so a title never reads as crowning one of two venues the
        // body says are level (perp-cost-slope, audit 2026-09-22).
        const tied = leaderNames(benchmark);
        if (tied.length > 1) return `${tied[0]} (tied)`;
        if (tied.length === 1) return tied[0];
        return best ? best.name : UNRESOLVED;
      }
      case "best_names": {
        // The tied set spelled out ("Gains and GMX v2"), for copy written
        // for a plural subject.
        const tied = leaderNames(benchmark);
        if (tied.length > 0) return joinNames(tied);
        return best ? best.name : UNRESOLVED;
      }
      case "best_p50":
        return best ? fmtUnit(best.ms.p50, benchmark.unit) : UNRESOLVED;
      case "worst_name":
        return worst ? worst.name : UNRESOLVED;
      case "worst_p50":
        return worst ? fmtUnit(worst.ms.p50, benchmark.unit) : UNRESOLVED;
      case "count":
        // The display cohort (5 % success floor), the same set the Results
        // table and the endpoints block count.
        return String(displayResults(benchmark.results).length);
      case "ranked_count":
        // The ranked cohort the TL;DR, the leader and /api/stat rankings use
        // (50 % success floor, spec rank gate, sample gate). Copy that names
        // a cohort size next to a leader claim uses this one, or both
        // ("13 ranked of 19 measured"), never {{count}} alone (audit
        // 2026-09-22: five pages stated two sizes).
        return String(rankedCandidates(benchmark).length);
      default:
        return whole;
    }
  });
  return pruneUnresolved(rendered);
}

/** Apply renderTemplate to every editorial field that supports it. The
 *  Benchmark object is mutated in place and returned for convenience.
 *
 *  Fields covered:
 *   - abstract, findings, seoIntro, faq, perChainExplainer: page body copy.
 *   - seoTitle, seoDescription: meta tags + RSC props serialized to the
 *     client. Without rendering these, a `{{best_name}}` token in
 *     `seo_description` survives into the response payload (and was
 *     visible in dev tools / view-source as raw template syntax). The
 *     bench page's generateMetadata also rendered against `b` directly,
 *     but anywhere else that read the field (the bench object passed
 *     to client components, /api/citable downstream consumers) got the
 *     raw token.
 *   - subtitle, methodology, disclaimer: same risk, smaller blast
 *     radius today but no reason to leave them unprocessed.
 */
export function renderBenchmarkText(benchmark: Benchmark): Benchmark {
  benchmark.abstract = renderTemplate(benchmark.abstract, benchmark);
  benchmark.findings = benchmark.findings.map((f) => renderTemplate(f, benchmark));
  benchmark.methodology = benchmark.methodology.map((m) =>
    renderTemplate(m, benchmark),
  );
  benchmark.subtitle = renderTemplate(benchmark.subtitle, benchmark);
  // A one-clause templated title or description renders to "" when the
  // bench has no live row (every placeholder unresolved, the clause
  // pruned); "" is not nullish, so the page's `?? title` fallback did not
  // fire and <title> shipped empty (review 2 2026-09-23). Store undefined.
  if (benchmark.seoTitle) {
    benchmark.seoTitle = renderTemplate(benchmark.seoTitle, benchmark).trim() || undefined;
  }
  if (benchmark.seoDescription) {
    benchmark.seoDescription = renderTemplate(benchmark.seoDescription, benchmark).trim() || undefined;
  }
  if (benchmark.seoIntro) {
    benchmark.seoIntro = renderTemplate(benchmark.seoIntro, benchmark);
  }
  if (benchmark.disclaimer) {
    benchmark.disclaimer = renderTemplate(benchmark.disclaimer, benchmark);
  }
  if (benchmark.faq) {
    benchmark.faq = benchmark.faq.map((item) => ({
      q: renderTemplate(item.q, benchmark),
      a: renderTemplate(item.a, benchmark),
    }));
  }
  if (benchmark.perChainExplainer) {
    benchmark.perChainExplainer = benchmark.perChainExplainer.map((item) => ({
      slug: item.slug,
      h2: renderTemplate(item.h2, benchmark),
      body: renderTemplate(item.body, benchmark),
    }));
  }
  return benchmark;
}
