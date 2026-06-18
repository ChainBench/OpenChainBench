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
 *  avoid a spec.ts → bench-template.ts → spec.ts circular import. */
function bestForChain(b: Benchmark, chain: string): ProviderResult | undefined {
  return b.bestPerChain?.[chain];
}
function worstForChain(b: Benchmark, chain: string): ProviderResult | undefined {
  return b.worstPerChain?.[chain];
}

export function renderTemplate(text: string, benchmark: Benchmark): string {
  if (!text || text.indexOf("{{") === -1) return text;
  const live = liveResults(benchmark.results);
  const sorted = rankResults(live, benchmark.higherIsBetter);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  // Resolve chain-scoped placeholders first so they don't fall through to
  // the unfiltered resolver as unknown tokens.
  const withChain = text.replace(
    CHAIN_TEMPLATE_RE,
    (whole, keyword: string, chain: string) => {
      const k = keyword.toLowerCase();
      const chainKey = chain.toLowerCase();
      if (k === "best_name") {
        const lead = bestForChain(benchmark, chainKey);
        return lead ? lead.name : whole;
      }
      if (k === "best_p50") {
        const lead = bestForChain(benchmark, chainKey);
        return lead ? fmtUnit(lead.ms.p50, benchmark.unit) : whole;
      }
      if (k === "worst_name") {
        const trailer = worstForChain(benchmark, chainKey);
        return trailer ? trailer.name : whole;
      }
      if (k === "worst_p50") {
        const trailer = worstForChain(benchmark, chainKey);
        return trailer ? fmtUnit(trailer.ms.p50, benchmark.unit) : whole;
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
        return best ? best.name : whole;
      case "best_p50":
        return best ? fmtUnit(best.ms.p50, benchmark.unit) : whole;
      case "worst_name":
        return worst ? worst.name : whole;
      case "worst_p50":
        return worst ? fmtUnit(worst.ms.p50, benchmark.unit) : whole;
      case "count":
        return String(live.length);
      default:
        return whole;
    }
  });
}

/** Apply renderTemplate to every editorial field that supports it. The
 *  Benchmark object is mutated in place and returned for convenience. */
export function renderBenchmarkText(benchmark: Benchmark): Benchmark {
  benchmark.abstract = renderTemplate(benchmark.abstract, benchmark);
  benchmark.findings = benchmark.findings.map((f) => renderTemplate(f, benchmark));
  if (benchmark.seoIntro) {
    benchmark.seoIntro = renderTemplate(benchmark.seoIntro, benchmark);
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
