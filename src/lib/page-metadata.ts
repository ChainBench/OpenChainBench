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
 */
export function pageMetadata({
  path,
  title,
  description,
}: {
  path: string;
  title: string;
  description: string;
}): Metadata {
  const url = `${SITE_ORIGIN}${path}`;
  const social = title.includes("OpenChainBench") ? title : `${title} · OpenChainBench`;
  const meta: Metadata = {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: social,
      description,
      url,
      type: "website",
      siteName: "OpenChainBench",
    },
    twitter: {
      card: "summary_large_image",
      title: social,
      description,
      site: "@openchainbench",
    },
  };
  return meta;
}
