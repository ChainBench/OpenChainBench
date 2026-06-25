/**
 * Shape of a single searchable document indexed at build time.
 *
 * One flat list is built once on the server (via `buildIndex.ts`) and
 * shipped to the client as JSON. Fuse.js then runs in the browser on
 * the cached list. Keep this type narrow: every extra field is sent
 * over the wire and weighs on the cmdk dialog's first paint.
 */
export type SearchKind =
  | "Benchmark"
  | "Product"
  | "Alternative"
  | "Answer"
  | "Chain"
  | "Compare"
  | "Page";

export type SearchItem = {
  /** Stable cmdk value. Slug-based, unique across all kinds. */
  id: string;
  /** Visible label rendered as the bold first line. */
  title: string;
  /** Kind badge, also used by cmdk to group results. */
  kind: SearchKind;
  /** Destination route (absolute, starts with `/`). */
  url: string;
  /** One-line description, ~150 chars max. Truncated in the UI. */
  description?: string;
  /** Extra haystack tokens for fuzzy matching (category, provider
   *  names, chain slugs). Never rendered. */
  tags?: string[];
};
