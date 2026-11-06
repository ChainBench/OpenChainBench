import { SEARCH_ENGINE_FAMILIES } from "@/data/search-engine-crawlers";
import type { SiteEvent } from "@/lib/analytics";
import { bareHost, isSameOrSubdomain, parseHttpUrl } from "@/lib/url-host";
import { isOwnOrIdentifierHost, withUtm } from "@/lib/utm";

const MAX_URL_LENGTH = 2048;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_PAGE_LENGTH = 200;
export const CONFIRMED_PARAM = "confirmed";
export const PASS_PARAM = "pass";
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u;
const IPV4_LITERAL = /^\d+(\.\d+){3}$/;
const ENGINE_VERSION = /(Chrome|Firefox)\/(\d+)/;
const CHROME_FETCH_METADATA_SINCE = 76;
const FIREFOX_FETCH_METADATA_SINCE = 90;
const SEARCH_ENGINES: ReadonlySet<string> = new Set(
  SEARCH_ENGINE_FAMILIES.map(([, family]) => family),
);

type ClientClickProps = Extract<
  SiteEvent,
  { name: "outbound_click" }
>["props"];

export type OutboundClick = Pick<ClientClickProps, "href" | "host" | "page"> & {
  via: "go" | "confirm";
};

type ContinueTo = "go" | "destination";

type PassStep = "offer" | "redeem" | "none";

export type GoDecision =
  | { kind: "reject" }
  | { kind: "background" }
  | { kind: "redirect"; destination: URL; click: OutboundClick | null }
  | {
      kind: "confirm";
      destination: URL;
      continueTo: ContinueTo;
      pass: PassStep;
    };

export type GoRequest = {
  to: string | null;
  family: string;
  agent: string;
  acceptsHtml: boolean;
  referer: string | null;
  fetchSite: string | null;
  confirmed: boolean;
  passed: boolean;
  selfHost: string;
  background: boolean;
};

function isPublicHostname(hostname: string): boolean {
  return (
    hostname.length <= MAX_HOSTNAME_LENGTH &&
    bareHost(hostname).includes(".") &&
    !IPV4_LITERAL.test(hostname)
  );
}

function isAllowedDestination(url: URL): boolean {
  return (
    url.href.length <= MAX_URL_LENGTH &&
    !url.username &&
    !url.password &&
    isPublicHostname(url.hostname)
  );
}

function parseDestination(to: string): URL | null {
  if (WHITESPACE_OR_CONTROL.test(to)) return null;
  const url = parseHttpUrl(to);
  return url && isAllowedDestination(url) ? url : null;
}

function ownPagePath(referer: string | null, selfHost: string): string | null {
  if (!referer || referer.length > MAX_URL_LENGTH) return null;
  const url = parseHttpUrl(referer);
  if (!url || bareHost(url.hostname) !== bareHost(selfHost)) return null;
  return url.pathname.slice(0, MAX_PAGE_LENGTH);
}

function sendsFetchMetadata(agent: string): boolean {
  const [, engine, major] = ENGINE_VERSION.exec(agent) ?? [];
  if (major === undefined) return false;
  const since =
    engine === "Firefox"
      ? FIREFOX_FETCH_METADATA_SINCE
      : CHROME_FETCH_METADATA_SINCE;
  return Number(major) >= since;
}

function passStep(confirmed: boolean, fetchSite: string | null): PassStep {
  if (confirmed) return "redeem";
  return fetchSite === null || fetchSite === "none" ? "offer" : "none";
}

export function decideGo(request: GoRequest): GoDecision {
  const { to, family, referer, fetchSite, confirmed, selfHost } = request;
  const destination = to === null ? null : parseDestination(to);
  if (!destination || isSameOrSubdomain(destination.hostname, selfHost)) {
    return { kind: "reject" };
  }
  if (request.background) return { kind: "background" };
  if (SEARCH_ENGINES.has(family)) {
    return { kind: "redirect", destination, click: null };
  }
  if (family !== "browser" || !request.acceptsHtml) {
    return {
      kind: "confirm",
      destination,
      continueTo: "destination",
      pass: "none",
    };
  }

  const trustsReferer =
    fetchSite !== null || !sendsFetchMetadata(request.agent);
  const page = trustsReferer ? ownPagePath(referer, selfHost) : null;
  const fromOwnPage = fetchSite === "same-origin" || page !== null;
  if (!fromOwnPage && !(confirmed && request.passed)) {
    const wouldLoop = confirmed || !trustsReferer;
    const continueTo = wouldLoop ? "destination" : "go";
    const pass = passStep(confirmed, fetchSite);
    return { kind: "confirm", destination, continueTo, pass };
  }
  const { href, host } = destination;
  const click: OutboundClick = confirmed
    ? { href, host, page: "", via: "confirm" }
    : { href, host, page: page ?? "", via: "go" };
  return { kind: "redirect", destination, click };
}

export function outboundHref(href: string | undefined): string {
  const tagged = withUtm(href);
  const url = parseHttpUrl(tagged);
  if (
    !url ||
    !isAllowedDestination(url) ||
    isOwnOrIdentifierHost(url.hostname)
  ) {
    return tagged;
  }
  return goHref(url);
}

function goHref(destination: URL): string {
  return `/go?to=${encodeURIComponent(destination.href)}`;
}

function confirmedGoHref(destination: URL): string {
  return `${goHref(destination)}&${CONFIRMED_PARAM}=1`;
}

export function continueHref(
  destination: URL,
  continueTo: ContinueTo,
  pass: string | null,
): string {
  if (pass !== null) {
    return `${confirmedGoHref(destination)}&${PASS_PARAM}=${encodeURIComponent(pass)}`;
  }
  return continueTo === "go" ? confirmedGoHref(destination) : destination.href;
}
