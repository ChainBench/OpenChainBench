/**
 * Safe serialization for inline `<script type="application/ld+json">`
 * blocks rendered via `dangerouslySetInnerHTML`.
 *
 * JSON.stringify alone does NOT escape `<`, `>`, `&`, U+2028 or U+2029.
 * A string containing `</script>` would close the surrounding script tag
 * and let the rest render as HTML - a stored-XSS vector if any field
 * inside the payload ever stops being editor-controlled.
 *
 * Today every JSON-LD field is derived from spec YAMLs or the provider
 * registry (both gated by PR review), so the escape is defense-in-depth.
 * Cheap insurance against a future regression that lets user input reach
 * any of these blocks.
 */
const LS = new RegExp("\\u2028", "g");
const PS = new RegExp("\\u2029", "g");

export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LS, "\\u2028")
    .replace(PS, "\\u2029");
}

/**
 * Strip inline markdown from a string so it can be embedded in a JSON-LD
 * Answer.text node. Google's Rich Results checker (and the indexing
 * pipeline behind it) treats Answer.text as plain text + a narrow HTML
 * allowlist; backticks, asterisks and bracketed link syntax surface as
 * literal characters in the SERP snippet when accepted, and have
 * historically been one of the silent failure modes that keeps a
 * FAQPage block from ever earning a rich result.
 *
 * We don't want a full markdown parser dependency for six characters
 * worth of formatting noise. The transformations below mirror what
 * shows up in `benchmarks/*.yml` faq blocks today:
 *   - inline code: `metric_name`         -> metric_name
 *   - bold:        **text** / __text__   -> text
 *   - italic:      *text* / _text_       -> text (only when paired)
 *   - md link:     [label](url)          -> label
 *   - em-dash:     U+2014                -> " - " (matches house style)
 *   - collapse runs of whitespace
 */
function stripFaqMarkdown(input: string): string {
  let s = input;
  // Links first so we capture the label before stripping brackets elsewhere.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Bold (double markers) before italic (single) so **x** doesn't become *x*.
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  // Italic. Paired markers only - bare `_` inside identifiers like
  // `bridge_cost_percent` must survive after the backtick pass below.
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)!?]|$)/g, "$1$2");
  // Inline code. Drop the backticks but keep contents verbatim.
  s = s.replace(/`([^`]+)`/g, "$1");
  // Em-dash and en-dash. House style is hyphen-with-spaces.
  s = s.replace(/—/g, " - ");
  s = s.replace(/–/g, "-");
  // Collapse any newlines / multi-space artifacts. Google reads Answer.text
  // as a single block; line breaks render as spaces in the snippet anyway.
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

type FaqItem = { q: string; a: string };

type CrumbItem = { name: string; item?: string };

/**
 * Build a BreadcrumbList JSON-LD node from ordered crumbs. Returns the
 * bare object (no @context) so it can be embedded in an @graph or
 * wrapped by the caller for standalone emission. Positions are derived
 * from array order so call sites can't skew them.
 */
export function buildBreadcrumbJsonLd(items: CrumbItem[]): Record<string, unknown> {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      ...(c.item ? { item: c.item } : {}),
    })),
  };
}

/**
 * Normalise a chain value into a JSON-LD-safe @id suffix. Lowercased,
 * letters/digits/hyphens only — strips anything that would need URL
 * encoding when concatenated into an @id fragment. Returns `null` for
 * the sentinel "all" and for empty input so call sites can fall back to
 * the unscoped @id seamlessly.
 */
function chainIdFragment(chain?: string | null): string | null {
  if (!chain) return null;
  const trimmed = chain.trim().toLowerCase();
  if (!trimmed || trimmed === "all") return null;
  const cleaned = trimmed.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || null;
}

/**
 * Build an ItemList JSON-LD graph for a hub/index page, optionally
 * including a BreadcrumbList in the same `@graph`. Centralises the
 * inline-object pattern that every hub page hand-rolls (products,
 * benchmarks, alternatives, compare, answers, chains, ...), so the
 * shape stays consistent across the site and a future addition (e.g.
 * `itemListOrder`, per-item `description`) lands in one place instead
 * of ~7 nearly-identical literals.
 *
 * Output stays content-equivalent to the previous literals: an
 * `ItemList` with `numberOfItems` + per-item `ListItem` { position, name,
 * url, optional description }, plus an optional `BreadcrumbList`
 * delegated to `buildBreadcrumbJsonLd` (no duplicate `position` logic).
 */
export function buildItemListJsonLd(params: {
  name: string;
  url: string;
  description?: string;
  items: Array<{ name: string; url: string; description?: string }>;
  breadcrumb?: Array<{ name: string; url: string }>;
}): Record<string, unknown> {
  const itemList: Record<string, unknown> = {
    "@type": "ItemList",
    name: params.name,
    url: params.url,
    numberOfItems: params.items.length,
    itemListElement: params.items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      url: item.url,
      ...(item.description ? { description: item.description } : {}),
    })),
  };
  if (params.description) itemList.description = params.description;

  const graph: Array<Record<string, unknown>> = [itemList];
  if (params.breadcrumb && params.breadcrumb.length > 0) {
    graph.push(
      buildBreadcrumbJsonLd(
        params.breadcrumb.map((c) => ({ name: c.name, item: c.url })),
      ),
    );
  }

  return {
    "@context": "https://schema.org",
    "@graph": graph,
  };
}

/**
 * Build a top-level FAQPage JSON-LD object per https://schema.org/FAQPage.
 *
 * Emitted as its own `<script type="application/ld+json">` block on the
 * bench page rather than nested inside an `@graph`. Google's Rich Results
 * Test parses both shapes; standalone FAQPage scripts have a markedly
 * higher hit rate in Search Console's "Rich result" reports (the
 * @graph-nested variant currently shipped on /benchmarks/* is what the
 * site rendered before this change, and Search Console showed zero
 * registered FAQ rich results).
 *
 * Caller is responsible for guarding empty `faq` arrays. Returns `null`
 * when there's nothing to emit so the call site can skip the script tag.
 *
 * `chain` is an optional context tag. When set, the @id gets a
 * `-<chain>` suffix so per-chain variants don't collide with the
 * unscoped FAQPage @id in Google's index.
 */
export function buildFaqPageJsonLd(
  faq: FaqItem[] | undefined,
  pageUrl: string,
  chain?: string | null,
): Record<string, unknown> | null {
  if (!faq || faq.length === 0) return null;
  const suffix = chainIdFragment(chain);
  const id = suffix ? `${pageUrl}#faq-${suffix}` : `${pageUrl}#faq`;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": id,
    mainEntity: faq.map((item) => ({
      "@type": "Question",
      name: stripFaqMarkdown(item.q),
      acceptedAnswer: {
        "@type": "Answer",
        text: stripFaqMarkdown(item.a),
      },
    })),
  };
}
