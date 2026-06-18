/**
 * Strip inline markdown from a string so it can be safely embedded in plain-text
 * contexts (JSON-LD Answer.text / Question.name, `<meta name="description">`,
 * Article.articleBody, etc.). None of those contexts render markdown — they
 * surface the source characters verbatim, which means backticks and asterisks
 * leak straight into SERP snippets and meta previews.
 *
 * Transformations (mirrors what shows up in `benchmarks/*.yml`):
 *   - md link:     [label](url)          -> label
 *   - bold:        **text** / __text__   -> text
 *   - italic:      *text* / _text_       -> text (paired markers only, so
 *                                          identifiers like `bridge_cost_percent`
 *                                          survive)
 *   - inline code: `metric_name`         -> metric_name
 *   - em-dash:     U+2014                -> " - " (house style)
 *   - en-dash:     U+2013                -> "-"
 *   - collapse runs of whitespace
 *
 * Not a full markdown parser — these six classes cover the YAML content we
 * actually ship. New tokens get added here once, not re-implemented inline.
 */
export function stripInlineMarkdown(input: string): string {
  let s = input;
  // Links first so we capture the label before stripping brackets elsewhere.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Bold (double markers) before italic (single) so **x** doesn't become *x*.
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  // Italic. Paired markers only - bare `_` inside identifiers like
  // `bridge_cost_percent` must survive after the backtick pass below.
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)!?]|$)/g, "$1$2");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:)!?]|$)/g, "$1$2");
  // Inline code. Drop the backticks but keep contents verbatim.
  s = s.replace(/`([^`]+)`/g, "$1");
  // Em-dash and en-dash. House style is hyphen-with-spaces.
  s = s.replace(/—/g, " - ");
  s = s.replace(/–/g, "-");
  // Collapse any newlines / multi-space artifacts.
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

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
  // Prefer cutting at a sentence end, otherwise the last word boundary.
  const lastDot = head.lastIndexOf(". ");
  if (lastDot > max * 0.6) return head.slice(0, lastDot + 1);
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > max * 0.6) return head.slice(0, lastSpace) + "…";
  return head + "…";
}
