import { captureServer, uaFamily } from "@/lib/analytics-server";
import { decideGo, type OutboundClick } from "@/lib/outbound-click";
import { escapeMarkup } from "@/lib/escape-markup";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { bareHost } from "@/lib/url-host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "cache-control": "no-store" };
const HTML_HEADERS = {
  ...NO_STORE_HEADERS,
  "content-type": "text/html; charset=utf-8",
};
const CLICKS_PER_WINDOW = 60;
const WINDOW_SEC = 60;
const PAGE_STYLE =
  "body{overflow-wrap:anywhere}a{display:inline-block;padding:13px 0}";

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>`;
}

const INVALID_LINK_PAGE = htmlPage(
  "Invalid link",
  `<p>This link is not valid, so nothing was opened.
Browse <a href="/benchmarks">all benchmarks</a>.</p>`,
);

function confirmationPage(destination: URL): string {
  const host = escapeMarkup(bareHost(destination.host));
  const href = escapeMarkup(destination.href);
  return htmlPage(
    "Leaving OpenChainBench",
    `<p>This link goes to ${host}.</p>
<p><a href="${href}" rel="noopener">Continue to ${host}</a></p>`,
  );
}

function isBackgroundRequest(headers: Headers): boolean {
  const dest = headers.get("sec-fetch-dest");
  return (
    headers.has("sec-purpose") ||
    headers.has("next-router-prefetch") ||
    (dest !== null && dest !== "document")
  );
}

function countClick(req: Request, click: OutboundClick | null): void {
  if (!click || req.method !== "GET") return;
  try {
    const key = clientKey(req, "go");
    if (rateLimit(key, CLICKS_PER_WINDOW, WINDOW_SEC).ok) {
      captureServer(req, "outbound_click", click);
    }
  } catch (error) {
    console.error("[go] click not counted", error);
  }
}

export function GET(req: Request): Response {
  const url = new URL(req.url);
  const decision = decideGo({
    to: url.searchParams.get("to"),
    family: uaFamily(req.headers.get("user-agent") ?? ""),
    referer: req.headers.get("referer"),
    selfHost: url.hostname,
    background: isBackgroundRequest(req.headers),
  });

  switch (decision.kind) {
    case "reject":
      return new Response(INVALID_LINK_PAGE, {
        status: 400,
        headers: HTML_HEADERS,
      });
    case "background":
      return new Response(null, { status: 204, headers: NO_STORE_HEADERS });
    case "redirect":
      countClick(req, decision.click);
      return new Response(null, {
        status: 302,
        headers: { ...NO_STORE_HEADERS, location: decision.destination.href },
      });
    case "confirm":
      countClick(req, decision.click);
      return new Response(confirmationPage(decision.destination), {
        status: 200,
        headers: HTML_HEADERS,
      });
    default:
      return decision satisfies never;
  }
}
