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
  // Fallback to the root /opengraph-image and /twitter-image when a hub
  // doesn't ship a dedicated card. Without this, Next.js treats the
  // per-page `openGraph` block as a full override and drops the
  // file-based root image, so /compare and /alternatives end up sharing
  // unbranded blank cards on every social embed.
  const meta: Metadata = {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title: social,
      description,
      url: socialUrl,
      type: "website",
      siteName: "OpenChainBench",
      images: [{ url: `${SITE_ORIGIN}/opengraph-image`, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: social,
      description,
      site: "@OpenChainBench",
      images: [`${SITE_ORIGIN}/twitter-image`],
    },
  };
  return meta;
}
