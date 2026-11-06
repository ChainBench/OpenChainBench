import { after } from "next/server";
import {
  captureServer,
  readSiteVisitors,
  uaFamily,
} from "@/lib/analytics-server";
import {
  CONFIRMED_PARAM,
  continueHref,
  decideGo,
  type GoDecision,
  type GoRequest,
  type OutboundClick,
  PASS_PARAM,
} from "@/lib/outbound-click";
import { escapeMarkup } from "@/lib/escape-markup";
import { claimOpening, issuePass, redeemPass } from "@/lib/go-markers";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { bareHost } from "@/lib/url-host";
import {
  type GoVisitor,
  newVisitor,
  type Visitor,
  visitorCookie,
} from "@/lib/visitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "cache-control": "no-store" };
const HTML_HEADERS = {
  ...NO_STORE_HEADERS,
  "content-type": "text/html; charset=utf-8",
};
const CLICKS_PER_WINDOW = 60;
const PASSES_PER_WINDOW = 60;
const WINDOW_SEC = 60;
const PAGE_STYLE =
  "body{overflow-wrap:anywhere}a{display:inline-block;padding:13px 0}";

type Confirmation = Extract<GoDecision, { kind: "confirm" }>;

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

function confirmationPage(destination: URL, continueLink: string): string {
  const host = escapeMarkup(bareHost(destination.host));
  const href = escapeMarkup(continueLink);
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
    headers.has("purpose") ||
    headers.has("x-purpose") ||
    headers.has("next-router-prefetch") ||
    (dest !== null && dest !== "document")
  );
}

type Opener =
  | { returning: true; visitor: Visitor; ids: string[] }
  | { returning: false; visitor: GoVisitor };

function openerKeys(req: Request, opener: Opener): string[] {
  if (opener.returning) return opener.ids;
  const agent = req.headers.get("user-agent") ?? "";
  return [`${clientKey(req, "go")}:${agent}`, opener.visitor.distinctId];
}

async function countOnce(
  req: Request,
  click: OutboundClick,
  opener: Opener,
): Promise<void> {
  const claim = await claimOpening(openerKeys(req, opener), click.href);
  if (claim === "repeat") return;
  const props = { ...click, repeat_checked: claim === "first" };
  captureServer(req, "outbound_click", props, opener.visitor);
}

function countClick(
  req: Request,
  click: OutboundClick | null,
  opener: Opener,
): void {
  if (!click || req.method !== "GET") return;
  if (!rateLimit(clientKey(req, "go"), CLICKS_PER_WINDOW, WINDOW_SEC).ok) {
    return;
  }
  after(() => countOnce(req, click, opener));
}

function withVisitorCookie(headers: HeadersInit, opener: Opener): Headers {
  const result = new Headers(headers);
  if (!opener.returning) {
    result.append("set-cookie", visitorCookie(opener.visitor));
  }
  return result;
}

function readOpener(req: Request): Opener {
  const known = readSiteVisitors(req);
  const [visitor] = known;
  if (!visitor) return { returning: false, visitor: newVisitor() };
  return { returning: true, visitor, ids: known.map((v) => v.distinctId) };
}

function readGoRequest(req: Request, url: URL): GoRequest {
  const agent = req.headers.get("user-agent") ?? "";
  return {
    to: url.searchParams.get("to"),
    family: uaFamily(agent),
    agent,
    referer: req.headers.get("referer"),
    fetchSite: req.headers.get("sec-fetch-site"),
    confirmed: url.searchParams.has(CONFIRMED_PARAM),
    passed: false,
    selfHost: url.hostname,
    background: isBackgroundRequest(req.headers),
  };
}

function mayUsePass(req: Request): boolean {
  const key = clientKey(req, "go-pass");
  return rateLimit(key, PASSES_PER_WINDOW, WINDOW_SEC).ok;
}

async function decideWithPass(req: Request, url: URL): Promise<GoDecision> {
  const request = readGoRequest(req, url);
  const decision = decideGo(request);
  const pass = url.searchParams.get(PASS_PARAM);
  if (
    decision.kind !== "confirm" ||
    decision.pass !== "redeem" ||
    pass === null ||
    req.method !== "GET" ||
    !mayUsePass(req)
  ) {
    return decision;
  }
  const passed = await redeemPass(pass, decision.destination.href);
  return passed ? decideGo({ ...request, passed }) : decision;
}

async function offerPass(
  req: Request,
  decision: Confirmation,
): Promise<string | null> {
  if (decision.pass !== "offer" || req.method !== "GET") return null;
  if (!mayUsePass(req)) return null;
  return issuePass(decision.destination.href);
}

async function confirm(
  req: Request,
  decision: Confirmation,
  opener: Opener,
): Promise<Response> {
  const { destination, continueTo } = decision;
  const pass = await offerPass(req, decision);
  const link = continueHref(destination, continueTo, pass);
  const backToGo = pass !== null || continueTo === "go";
  return new Response(confirmationPage(destination, link), {
    status: 200,
    headers: backToGo ? withVisitorCookie(HTML_HEADERS, opener) : HTML_HEADERS,
  });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const opener = readOpener(req);
  const decision = await decideWithPass(req, url);

  switch (decision.kind) {
    case "reject":
      return new Response(INVALID_LINK_PAGE, {
        status: 400,
        headers: HTML_HEADERS,
      });
    case "background":
      return new Response(null, { status: 204, headers: NO_STORE_HEADERS });
    case "redirect": {
      countClick(req, decision.click, opener);
      const headers = {
        ...NO_STORE_HEADERS,
        location: decision.destination.href,
      };
      return new Response(null, {
        status: 302,
        headers: decision.click ? withVisitorCookie(headers, opener) : headers,
      });
    }
    case "confirm":
      return confirm(req, decision, opener);
    default:
      return decision satisfies never;
  }
}
