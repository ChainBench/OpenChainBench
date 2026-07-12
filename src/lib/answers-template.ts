/**
 * Neutral fallback for any `{{ ... }}` template token that
 * `renderTemplate` could not resolve. Fires when an answer YAML's
 * referenced bench has no live data (status: draft, every provider's
 * p50 = 0, every per-chain slug missing from results) so that a literal
 * brace string never reaches the rendered HTML or the SERP.
 *
 * Pattern mirrors `resolveLeftoverPlaceholders` in the per-chain bench
 * page route, extended to cover the unfiltered `{{best_name}}` /
 * `{{best_p50}}` shape used by question YAMLs.
 */
export function cleanLeftoverTokens(text: string): string {
  return text
    .replace(
      /\{\{\s*best_name(?::chain:[a-z0-9_-]+)?\s*\}\}/gi,
      "The current leader",
    )
    .replace(
      /\{\{\s*worst_name(?::chain:[a-z0-9_-]+)?\s*\}\}/gi,
      "the trailing provider",
    )
    .replace(
      /\{\{\s*best_p50(?::chain:[a-z0-9_-]+)?\s*\}\}/gi,
      "measured live",
    )
    .replace(
      /\{\{\s*worst_p50(?::chain:[a-z0-9_-]+)?\s*\}\}/gi,
      "measured live",
    )
    .replace(
      /\{\{\s*(p50|p90|p99|mean):[a-z0-9_-]+\s*\}\}/gi,
      "measured live",
    )
    .replace(/\{\{\s*name:[a-z0-9_-]+\s*\}\}/gi, "the provider")
    .replace(/\{\{\s*count\s*\}\}/gi, "every");
}

/**
 * Detect whether a pre-render source string contains any of the
 * placeholder tokens that require live bench data. Used at the answers
 * page level to swap the whole short_answer / intro / FAQ set with a
 * canned "data pending" message when the referenced bench has no
 * defensible values, rather than letting `cleanLeftoverTokens` produce
 * grammatically broken sentences like "The current leader currently
 * leads at measured live (p50, 24h)".
 *
 * Pattern matches every `{{ ... }}` shape our `renderTemplate` and
 * `cleanLeftoverTokens` know about so we can decide once at the caller
 * whether the source depends on live data before rendering starts.
 */
export function hasLiveDataTokens(source: string): boolean {
  return /\{\{\s*(?:best_name|best_p50|worst_name|worst_p50|p50|p90|p99|mean|name|count)/i.test(
    source,
  );
}

/**
 * Canned fallback text shipped in place of the rendered `short_answer` /
 * `intro` / `methodology` etc when the referenced bench has no leader.
 * Written to read naturally in every downstream surface (meta
 * description, TL;DR block, JSON-LD Article.description, LLM
 * grounding trace) without triggering the "double leads" grammar bug.
 *
 * The `subject` argument is the answer's question topic (e.g.
 * "Solana transaction landing latency") so the fallback stays specific
 * enough not to read as a generic error page.
 */
export function benchDataPendingFallback(
  benchTitle: string,
  benchUrl: string,
): {
  short_answer: string;
  intro: string;
  methodology: string;
} {
  const shortAnswer = `Live data for ${benchTitle} is still being collected. See ${benchUrl} for the latest measured values as soon as the benchmark stabilises.`;
  const intro = `This question is answered live from the ${benchTitle} benchmark. The current run has not yet accumulated enough samples to name a leader; the intro on this page will populate automatically as soon as the underlying benchmark reports a defensible aggregate. In the meantime the benchmark page at ${benchUrl} shows the running measurements and their sample health so a reader can decide whether the current data is already usable for their specific question.`;
  const methodology = `Methodology is defined by the underlying ${benchTitle} benchmark and is published in full at ${benchUrl}. Once the benchmark aggregates cross the sample-health threshold, the methodology section on this page renders the exact one-liner used to compute the headline number, sourced from the benchmark's own methodology YAML rather than duplicated in the answer file.`;
  return { short_answer: shortAnswer, intro, methodology };
}
