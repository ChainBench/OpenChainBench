import { ImageResponse } from "next/og";

type OgOptions = NonNullable<ConstructorParameters<typeof ImageResponse>[1]>;

/**
 * Every generated image (opengraph-image, twitter-image, /api/og, share
 * cards) goes through here so it carries `X-Robots-Tag: noindex`.
 * Search Console listed about 200 of these image URLs under "Crawled,
 * currently not indexed" on 2026-09-19: Google fetched each one from the
 * og:image meta and then had to decide about it. The header settles the
 * decision at fetch time; social cards, Discover and LLM crawlers still
 * fetch the image normally (noindex is not a fetch block).
 *
 * THE FAVICON IS THE EXCEPTION, and it was not one until 2026-10-02.
 * /icon and /apple-icon went through here too, so the site mark carried
 * noindex from 2026-09-19 and Google showed its default globe next to
 * every result instead of the logo. A favicon is not a share image: it
 * is a resource Google has to store and serve beside the listing, and
 * telling it not to index the only asset it needs for that is
 * self-defeating. Icons pass `indexable: true` and get no header.
 */
export function ogResponse(
  element: React.ReactElement,
  options?: OgOptions & { indexable?: boolean },
): ImageResponse {
  const { indexable, ...rest } = options ?? {};
  return new ImageResponse(element, {
    ...rest,
    headers: indexable
      ? { ...(rest.headers ?? {}) }
      : { "X-Robots-Tag": "noindex", ...(rest.headers ?? {}) },
  });
}
