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
