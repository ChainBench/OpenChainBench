import type { SiteEvent } from "@/lib/analytics";
import {
  bareHost,
  isOwnOrIdentifierHost,
  isSameOrSubdomain,
  parseHttpUrl,
  withUtm,
} from "@/lib/utm";

const MAX_URL_LENGTH = 2048;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_PAGE_LENGTH = 200;
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u;
const IPV4_LITERAL = /^\d+(\.\d+){3}$/;

type ClientClickProps = Extract<
  SiteEvent,
  { name: "outbound_click" }
>["props"];

export type OutboundClick = Pick<ClientClickProps, "href" | "host" | "page"> & {
  via: "go" | "confirm";
};

type GoDecision =
  | { kind: "reject" }
  | { kind: "background" }
  | { kind: "redirect"; destination: URL; click: OutboundClick | null }
  | { kind: "confirm"; destination: URL; click: OutboundClick };

type GoRequest = {
  to: string | null;
  family: string;
  referer: string | null;
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

export function decideGo(request: GoRequest): GoDecision {
  const { to, family, referer, selfHost, background } = request;
  const destination = to === null ? null : parseDestination(to);
  if (!destination || isSameOrSubdomain(destination.hostname, selfHost)) {
    return { kind: "reject" };
  }
  if (background) return { kind: "background" };
  if (family !== "browser") {
    return { kind: "redirect", destination, click: null };
  }

  const { href, host } = destination;
  const page = ownPagePath(referer, selfHost);
  if (page === null) {
    const click: OutboundClick = { href, host, page: "", via: "confirm" };
    return { kind: "confirm", destination, click };
  }
  const click: OutboundClick = { href, host, page, via: "go" };
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
  return `/go?to=${encodeURIComponent(url.href)}`;
}
