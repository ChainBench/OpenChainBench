/**
 * Cap a string for JSON-LD description fields.
 *
 * Google's Rich Results validator caps `description` at ~1000 characters even
 * though schema.org Dataset/Article specs allow 5000. Strings longer than the
 * limit trip the "Invalid string length" warning in Search Console, which
 * strips the page's rich snippets and pushes rankings down.
 *
 * We trim to `max - 1` characters at the last sentence/word boundary, then
 * append `…` so the truncation reads cleanly.
 */
export function capDescription(input: string | undefined, max = 990): string {
  const s = (input ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  // Prefer cutting at a sentence end, but only when that keeps most of
  // the budget: at 0.6 the Polymarket answer (323 impressions, 0.3 % CTR
  // at position 7.6) shipped a 102-character snippet and lost its hook
  // ("Sports vs crypto vs politics, disputes and the pending backlog").
  const lastDot = head.lastIndexOf(". ");
  if (lastDot > max * 0.8) return head.slice(0, lastDot + 1);
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > max * 0.6) return head.slice(0, lastSpace) + "…";
  return head + "…";
}

/** Meta descriptions must not leak inline markdown from the YAML body
 *  (backticks around RPC method names, bold, links): 32 of 153 chain RPC
 *  descriptions reached the SERP as "(`eth_getBlockByNumber` p50, 24h)"
 *  on 2026-09-19. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
