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
 *   {{p50:<slug>}}         live p50 for a provider, formatted with the
 *                          benchmark's unit. e.g. "6.6 min" / "397 ms".
 *   {{p99:<slug>}}         same for p99.
 *   {{mean:<slug>}}        same for mean.
 *   {{name:<slug>}}        provider display name.
 *   {{best_name}}          name of the leading provider (best p50).
 *   {{best_p50}}           p50 of the leader, formatted.
 *   {{worst_name}}         name of the trailing provider.
 *   {{worst_p50}}          p50 of the trailing provider, formatted.
 *   {{count}}              number of providers with live data.
 *
 * Unknown placeholders are left untouched so a typo in the YAML can't
 * silently erase a sentence.
 */

import type { Benchmark } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";

// Keyword allows digits ({{p50:slug}}, {{best_p50}}, {{worst_p99}}) and
// underscores, must start with a letter. The earlier [a-z_]+ form
// silently dropped every percentile placeholder because the `5` in `p50`
// fell outside the character class - the match never anchored, leaving
// the literal `{{p50:slug}}` in the rendered page.
const TEMPLATE_RE = /\{\{\s*([a-z][a-z0-9_]*)(?::([a-z0-9-]+))?\s*\}\}/gi;

export function renderTemplate(text: string, benchmark: Benchmark): string {
  if (!text || text.indexOf("{{") === -1) return text;
  const liveResults = benchmark.results.filter((r) => r.availability !== "unavailable" && r.ms.p50 > 0);
  const sorted = [...liveResults].sort((a, b) =>
    benchmark.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50
  );
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  return text.replace(TEMPLATE_RE, (whole, keyword: string, arg?: string) => {
    const k = keyword.toLowerCase();
    switch (k) {
      case "p50":
      case "p99":
      case "mean":
      case "name": {
        if (!arg) return whole;
        const provider = liveResults.find(
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
        return String(liveResults.length);
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
