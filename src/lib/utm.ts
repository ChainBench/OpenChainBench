import { SITE } from "@/data/site";

/**
 * Tags an outbound link so the destination can see the traffic came from
 * here. Providers ask us how much we send them; without this the answer
 * is buried in their referrer reports, and for the ones fronted by a
 * privacy-preserving browser there is no referrer at all.
 *
 * Applied at RENDER time, never stored. The registry and the specs keep
 * clean URLs, so the JSON the API serves, the citations, the structured
 * data and anything a reader copies stay canonical. Only the href a human
 * clicks carries the tag.
 *
 * What it deliberately leaves alone:
 *
 *  - Anything that is not http(s): mailto:, tel:, #anchors, relative
 *    paths. A query string on those is either meaningless or breaks them.
 *  - Our own site, including subdomains. An internal link does not need
 *    to tell us where it came from, and tagging one would corrupt the
 *    session attribution in PostHog by starting a new campaign mid-visit.
 *  - A URL that already carries utm_source, so a hand-written campaign
 *    link keeps its own attribution.
 *  - Identifiers that happen to be URLs: a DOI and a Creative Commons
 *    license deed are cited verbatim, appear in JSON-LD as well as in
 *    prose, and a tracking parameter on them is wrong in both places.
 *
 * It is NOT applied to RPC endpoint URLs. Those are shown so a reader can
 * paste them into a config; a utm_source in one would be copied straight
 * into production. They never pass through here, and the test in
 * utm.test.ts pins that.
 */
const SITE_HOST = new URL(SITE.url).hostname.replace(/^www\./, "");

/** Hosts whose URLs are identifiers, not destinations. */
const IDENTIFIER_HOSTS = new Set(["doi.org", "dx.doi.org", "creativecommons.org"]);

export const UTM_SOURCE = "openchainbench";

export function withUtm(href: string | null | undefined): string {
  if (!href) return "";
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return href; // relative path, #anchor, or malformed: leave it alone
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return href;

  const host = u.hostname.replace(/^www\./, "");
  if (host === SITE_HOST || host.endsWith(`.${SITE_HOST}`)) return href;
  if (IDENTIFIER_HOSTS.has(host)) return href;
  if (u.searchParams.has("utm_source")) return href;

  u.searchParams.set("utm_source", UTM_SOURCE);
  return u.toString();
}
