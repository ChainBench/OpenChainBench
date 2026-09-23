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
  // The longest run of whole sentences that fits. These descriptions open
  // with the claim ("GMGN leads trading platforms at $112.66M 24h volume."),
  // so a clean cut keeps the hook and drops the enumeration, where the old
  // 0.8 threshold fell through to a word cut and shipped "8 live
  // benchmarks, 9…" on /products/mobula and four other audited pages.
  const lastDot = head.lastIndexOf(". ");
  if (lastDot > 0) return head.slice(0, lastDot + 1);
  // No sentence end inside the budget: one very long opening clause. Cut at
  // a word and say so with the ellipsis rather than mid-word.
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > max * 0.6) return head.slice(0, lastSpace) + "…";
  return head + "…";
}

/** Cap a meta description without ever appending an ellipsis. A snippet
 *  cut at "at 142 (p50,…" is what the SERP shows and what an answer
 *  engine quotes; the cut lands at the last sentence end when one sits
 *  past 60 characters, else the last clause (comma), else the last word,
 *  always closed with a period (audit 2026-09-22: 58 % of product pages
 *  shipped an ellipsis). JSON-LD descriptions keep capDescription. */
export function capSnippet(input: string | undefined, max = 155): string {
  const s = (input ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const lastDot = head.lastIndexOf(". ");
  if (lastDot > 60) return head.slice(0, lastDot + 1);
  // The clause cut must not land inside a parenthesis: "(Orca pool, Jupiter
  // route)" was cut at its inner comma and shipped as "(Orca pool." (RWA
  // audit 2026-09-23). Walk back to the last ", " whose prefix has balanced
  // parentheses; if none, cut before the unmatched "(".
  const balanced = (t: string) => (t.match(/\(/g)?.length ?? 0) === (t.match(/\)/g)?.length ?? 0);
  let lastComma = head.lastIndexOf(", ");
  while (lastComma > 60 && !balanced(head.slice(0, lastComma))) {
    lastComma = head.lastIndexOf(", ", lastComma - 1);
  }
  let cut = lastComma > 60 ? head.slice(0, lastComma) : head.slice(0, head.lastIndexOf(" "));
  if (!balanced(cut)) cut = cut.slice(0, cut.lastIndexOf("("));
  return cut.replace(/[,;:\s]+$/, "") + ".";
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
