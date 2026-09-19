import { ImageResponse } from "next/og";

type OgOptions = NonNullable<ConstructorParameters<typeof ImageResponse>[1]>;

/**
 * Every generated image (opengraph-image, twitter-image, icons, /api/og,
 * share cards) goes through here so it carries `X-Robots-Tag: noindex`.
 * Search Console listed about 200 of these image URLs under "Crawled,
 * currently not indexed" on 2026-09-19: Google fetched each one from the
 * og:image meta and then had to decide about it. The header settles the
 * decision at fetch time; social cards, Discover and LLM crawlers still
 * fetch the image normally (noindex is not a fetch block).
 */
export function ogResponse(
  element: React.ReactElement,
  options?: OgOptions,
): ImageResponse {
  return new ImageResponse(element, {
    ...options,
    headers: { "X-Robots-Tag": "noindex", ...(options?.headers ?? {}) },
  });
}
