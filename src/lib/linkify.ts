/**
 * Split prose into text and the https URLs inside it, so a renderer can turn
 * the URLs into anchors without ever building HTML from a string.
 *
 * Why this exists. Every spec carries written methodology, and several of
 * them name the upstream they read from, with its URL, in that prose. None
 * of those URLs has ever been a link: the bench page rendered the abstract
 * and never the methodology array, so the credit sat in JSON-LD and in the
 * Markdown view and was invisible to a reader. tehcscreener is named 41
 * times across one bench page and linked zero times, while seven benches
 * are built on its free keyless API.
 *
 * The parser is deliberately narrow. It matches https:// only, stops at
 * whitespace, and trims the punctuation a sentence leaves attached, so
 * "(https://example.com)," yields the bare URL. Anything it does not match
 * stays text, and nothing is ever passed to dangerouslySetInnerHTML.
 */

export type LinkPart =
  | { kind: "text"; value: string }
  | { kind: "link"; href: string; label: string };

/** Trailing characters that belong to the sentence, not to the URL. */
const TRAILING = /[).,;:!?'"\]]+$/;

const URL_RE = /https:\/\/[^\s<>"]+/g;

export function linkifyParts(input: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let last = 0;
  for (const m of input.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    let url = m[0];
    // A URL at the end of a clause carries the clause's punctuation. Give
    // it back to the text, or the anchor points at a 404 and the visible
    // label reads wrong.
    const trail = url.match(TRAILING)?.[0] ?? "";
    if (trail) url = url.slice(0, url.length - trail.length);
    if (!url) continue;
    if (at > last) parts.push({ kind: "text", value: input.slice(last, at) });
    parts.push({ kind: "link", href: url, label: display(url) });
    last = at + url.length;
  }
  if (last < input.length) parts.push({ kind: "text", value: input.slice(last) });
  return parts;
}

/**
 * What the reader sees. The scheme and a trailing slash are noise in prose,
 * and a long path buries the host, which is the part that credits anyone.
 */
function display(url: string): string {
  let out = url.replace(/^https:\/\//, "");
  if (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}
