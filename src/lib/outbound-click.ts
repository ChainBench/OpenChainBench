import type { SiteEvent } from "@/lib/analytics";
import {
  bareHost,
  isOwnOrIdentifierHost,
  isSameOrSubdomain,
  withUtm,
} from "@/lib/utm";

const MAX_DESTINATION_LENGTH = 2048;
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
  | { kind: "prefetch" }
  | { kind: "redirect"; destination: URL; click: OutboundClick | null }
  | { kind: "confirm"; destination: URL; click: OutboundClick };

export type GoRequest = {
  to: string | null;
  family: string;
  referer: string | null;
  selfHost: string;
  prefetch: boolean;
};

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function isPublicHostname(hostname: string): boolean {
  return (
    hostname.length <= MAX_HOSTNAME_LENGTH &&
    bareHost(hostname).includes(".") &&
    !IPV4_LITERAL.test(hostname)
  );
}

function parseDestination(to: string): URL | null {
  if (WHITESPACE_OR_CONTROL.test(to)) return null;
  const url = parseHttpUrl(to);
  if (!url || url.href.length > MAX_DESTINATION_LENGTH) return null;
  if (url.username || url.password) return null;
  return isPublicHostname(url.hostname) ? url : null;
}

function ownPagePath(referer: string | null, selfHost: string): string | null {
  const url = referer ? parseHttpUrl(referer) : null;
  if (!url || bareHost(url.hostname) !== bareHost(selfHost)) return null;
  return url.pathname.slice(0, MAX_PAGE_LENGTH);
}

export function decideGo(request: GoRequest): GoDecision {
  const { to, family, referer, selfHost, prefetch } = request;
  const destination = to === null ? null : parseDestination(to);
  if (!destination || isSameOrSubdomain(destination.hostname, selfHost)) {
    return { kind: "reject" };
  }
  if (prefetch) return { kind: "prefetch" };
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

export function outboundHref(href: string | null | undefined): string {
  const tagged = withUtm(href);
  const normalized = parseHttpUrl(tagged)?.href ?? tagged;
  const destination = parseDestination(normalized);
  if (!destination || isOwnOrIdentifierHost(destination.hostname)) {
    return tagged;
  }
  return `/go?to=${encodeURIComponent(destination.href)}`;
}
