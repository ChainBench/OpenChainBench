/**
 * The site's custom PostHog events, one place. `track` is a no-op when
 * PostHog is not initialised (no key, server side, blocked script), so call
 * sites never guard.
 *
 *   outbound_click  {href, host, text, page}   a link to another site, delegated listener
 *   copy            {kind, value?, bench?}     endpoint / API URL / MCP URL or config / embed / brief
 *   search          {query, kind, url}         a result picked in the search dialog
 *
 * Properties carry no personal data: URLs of our own pages and of public
 * endpoints, the query the visitor typed, the provider host they left for.
 */
import posthog from "posthog-js";

export type SiteEvent =
  | { name: "outbound_click"; props: { href: string; host: string; text: string; page: string } }
  | { name: "copy"; props: { kind: "endpoint" | "api_url" | "mcp_url" | "mcp_config" | "embed" | "brief" | "other"; value?: string; bench?: string } }
  | { name: "search"; props: { query: string; kind: string; url: string } };

/** Typed per event: `track("search", { kind: "endpoint" })` does not compile. */
export function track<N extends SiteEvent["name"]>(name: N, props: Extract<SiteEvent, { name: N }>["props"]): void {
  if (typeof window === "undefined") return;
  try {
    if (!posthog.__loaded) return;
    posthog.capture(name, props);
  } catch {
    // analytics never breaks the page
  }
}
