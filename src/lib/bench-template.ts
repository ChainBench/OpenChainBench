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
 *   {{p99:<slug>}}             same for p99.
 *   {{mean:<slug>}}            same for mean.
 *   {{name:<slug>}}            provider display name.
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
 *   {{count}}                  number of providers with live data.
 *
 * Unknown placeholders are left untouched so a typo in the YAML can't
 * silently erase a sentence.
 */

import type { Benchmark, ProviderResult } from "@/types/benchmark";
import { liveResults } from "@/lib/provider-filters";
import { citationCandidates } from "@/lib/citation";
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
const CHAIN_TEMPLATE_RE =
  /\{\{\s*(best_name|best_p50|worst_name|worst_p50):chain:([a-z0-9_-]+)\s*\}\}/gi;

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
        return lead ? lead.name : "";
      }
      if (k === "best_p50") {
        const lead = bestForChain(benchmark, chain);
        return lead ? fmtUnit(lead.ms.p50, benchmark.unit) : "";
      }
      if (k === "worst_name") {
        const trailer = worstForChain(benchmark, chain);
        return trailer ? trailer.name : "";
      }
      if (k === "worst_p50") {
        const trailer = worstForChain(benchmark, chain);
        return trailer ? fmtUnit(trailer.ms.p50, benchmark.unit) : "";
      }
      return whole;
    },
  );

  return withChain.replace(TEMPLATE_RE, (whole, keyword: string, arg?: string) => {
    const k = keyword.toLowerCase();
    switch (k) {
      case "p50":
      case "p99":
      case "mean":
      case "name": {
        if (!arg) return whole;
        const provider = live.find(
          (r) => r.slug.toLowerCase() === arg.toLowerCase()
        );
        if (!provider) return whole;
        if (k === "name") return provider.name;
        const raw = provider.ms[k as "p50" | "p99" | "mean"];
        return fmtUnit(raw, benchmark.unit);
      }
      case "best_name":
        return best ? best.name : "";
      case "best_p50":
        return best ? fmtUnit(best.ms.p50, benchmark.unit) : "";
      case "worst_name":
        return worst ? worst.name : "";
      case "worst_p50":
        return worst ? fmtUnit(worst.ms.p50, benchmark.unit) : "";
      case "count":
        return String(live.length);
      default:
        return whole;
    }
  });
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
  if (benchmark.seoTitle) {
    benchmark.seoTitle = renderTemplate(benchmark.seoTitle, benchmark);
  }
  if (benchmark.seoDescription) {
    benchmark.seoDescription = renderTemplate(benchmark.seoDescription, benchmark);
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
