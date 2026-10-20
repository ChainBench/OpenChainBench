/**
 * Dates for the hub pages that carry measurements.
 *
 * Measured on 2026-10-20 from the served HTML of every hub: six of them show
 * numbers and publish no date at all in their JSON-LD. /rpc serves 200 values,
 * /benchmarks 195, /trading-apps 171, /bridge 78, /trading-agents 48 and
 * /data-api 40, and an engine quoting any of them cannot say when the figure
 * was true. Four more (/, /rwa, /capital, and the bench pages) already carry a
 * `dateModified` through their Dataset node, and none of the hubs carried a
 * `datePublished`.
 *
 * Each hub emits a bare `ItemList` as its JSON-LD root. `ItemList` is not a
 * CreativeWork, so a date does not belong on it: `datedCollectionLd` wraps it
 * in the `CollectionPage` that is the page, and puts the dates there.
 */

/**
 * When each hub was first published, pinned by hand.
 *
 * Read once from `git log --diff-filter=A` on each route file and written down,
 * which is the opposite of what `scripts/generate-bench-published.mjs` did: it
 * recomputed on every run and could only move a date forward, and it did, on
 * launchpad-wars in October. A publication date is a historical fact; the way
 * to keep it true is to stop asking.
 *
 * A route that is rewritten keeps its date. A route genuinely replaced by a
 * different page gets a new one here, deliberately.
 */
export const HUB_PUBLISHED: Record<string, string> = {
  "/benchmarks": "2026-04-28",
  "/products": "2026-05-17",
  "/hyperliquid": "2026-06-17",
  "/prediction-markets": "2026-06-22",
  "/perps": "2026-06-24",
  "/rpc": "2026-07-03",
  "/bridge": "2026-07-27",
  "/reports": "2026-07-27",
  "/data-api": "2026-07-29",
  "/trading-apps": "2026-08-15",
  "/rwa": "2026-09-23",
  "/capital": "2026-09-25",
  "/trading-agents": "2026-10-06",
  "/tools": "2026-10-13",
};

/**
 * The stalest of a hub's timestamps, as an ISO string, or null when it has
 * none.
 *
 * The stalest and not the freshest: a hub that shows two benches side by side
 * is only as current as the older of them. /bridge took the newer of its two
 * and so presented a bench last read at 21:43 as if it had been read at 21:48.
 */
export function hubDateModified(
  stamps: (string | null | undefined)[],
): string | null {
  const valid = stamps
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .filter((s) => Number.isFinite(Date.parse(s)))
    .sort();
  return valid[0] ?? null;
}

/**
 * Wrap a hub's ItemList in the dated CollectionPage that carries it.
 *
 * `dateModified` is omitted rather than guessed when the page has no
 * timestamp: a date that is actually the render time says the page changed
 * when only the clock did, which is the claim this whole change exists to
 * remove.
 */
export function datedCollectionLd(params: {
  /** Route path, e.g. "/rpc". Used for the @id and to look up the pinned date. */
  path: string;
  /** Absolute URL of the page. */
  url: string;
  name: string;
  description?: string;
  /** The hub's existing ItemList node. Its own "@context" is dropped: the
   *  graph carries one. */
  itemList: Record<string, unknown>;
  dateModified: string | null;
}): Record<string, unknown> {
  const { "@context": _dropped, ...itemList } = params.itemList as Record<string, unknown>;
  const page: Record<string, unknown> = {
    "@type": "CollectionPage",
    "@id": `${params.url}#page`,
    url: params.url,
    name: params.name,
    // The real id the root layout emits for the WebSite node. Guessing it
    // would make isPartOf point at nothing, which is worse than omitting it.
    isPartOf: { "@id": "https://openchainbench.com/#site" },
    mainEntity: itemList,
  };
  if (params.description) page.description = params.description;
  const published = HUB_PUBLISHED[params.path];
  if (published) page.datePublished = published;
  if (params.dateModified) page.dateModified = params.dateModified;
  return { "@context": "https://schema.org", "@graph": [page] };
}
