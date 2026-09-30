import type { Metadata } from "next";

const SITE_ORIGIN = "https://openchainbench.com";

/**
 * Build per-page <Metadata> with canonical + per-page OpenGraph and Twitter
 * Card overrides. Without this helper, Next.js merges the root layout's
 * `openGraph` block for every child that doesn't redeclare it, so all hub
 * pages were serving the home page's og:url / og:title / og:image — which
 * broke link previews on every share of /benchmarks, /products, /about, etc.
 *
 * Pass `path` with a leading slash. `title` should be the bare page title
 * (without the " · OpenChainBench" suffix — the social card needs it spelled
 * out so the preview reads cleanly outside the tab template).
 *
 * `chain` is an optional context tag. When provided, it's surfaced in the
 * `og:url` query string so per-chain shares get distinct link previews,
 * but the canonical URL stays unfiltered so Google consolidates rank
 * signal on the hub page instead of fragmenting it across N chain
 * variants (classic duplicate-content avoidance).
 */
export function pageMetadata({
  path,
  title,
  description,
  chain,
}: {
  path: string;
  title: string;
  description: string;
  chain?: string | null;
}): Metadata {
  const canonical = `${SITE_ORIGIN}${path}`;
  const socialUrl = chain && chain !== "all" ? `${canonical}?chain=${chain}` : canonical;
  const social = title.includes("OpenChainBench") ? title : `${title} · OpenChainBench`;
  // No `images` on either block below, deliberately.
  //
  // This used to pin `images` to the ROOT /opengraph-image and
  // /twitter-image, described as a fallback for hubs without a dedicated
  // card. It was not a fallback, it was an unconditional override, and
  // config-based `images` beats the file convention: 28 of the 30 routes
  // that call this ship their own opengraph-image.tsx, every one of them
  // was built and served at its own URL, and not one was ever named in a
  // meta tag. Every hub shared the root card instead.
  //
  // Leaving `images` out lets Next resolve it from the route's own
  // opengraph-image.tsx, and it also fills twitter:image from that same
  // file when the route has no twitter-image.tsx of its own (checked in
  // dev: /team, /capital and /perps each emit both tags pointing at their
  // own card, with its real alt text and dimensions).
  //
  // What it does NOT do is inherit from an ancestor segment. There is no
  // cascade: a route with no opengraph-image.tsx of its own emits no
  // og:image at all, the root file notwithstanding. Checked the same way,
  // and it is why /rwa, /rpc-map and /perps/[asset] each gained a
  // one-line re-export file in this change. So every caller of this helper
  // needs a file in its own segment; adding a new hub without one ships it
  // with no share card and nothing will complain.
  const meta: Metadata = {
    // The layout template appends " · OpenChainBench" (17 characters):
    // past 43 the tail of the title, where the measured number sits, is
    // what the SERP cuts. Long titles ship absolute, short ones keep the
    // suffix; the social title above always carries the brand.
    title: title.length > 43 ? { absolute: title } : title,
    description,
    alternates: { canonical },
    openGraph: {
      title: social,
      description,
      url: socialUrl,
      type: "website",
      siteName: "OpenChainBench",
    },
    twitter: {
      card: "summary_large_image",
      title: social,
      description,
      site: "@OpenChainBench",
    },
  };
  return meta;
}
