import { after } from "next/server";
import { createHash } from "node:crypto";
import { AI_CRAWLER_FAMILIES } from "@/data/ai-crawlers";

/**
 * Server-side PostHog capture for the surfaces a browser never renders:
 * the Markdown views (`Accept: text/markdown`), `/api/stat`, `/api/citable`.
 * The client SDK only sees pages that run JavaScript, so the answer-engine
 * and agent traffic the GEO work targets was invisible (2026-09-24).
 *
 * Fire and forget through `after()`: the response is sent first, the
 * event is posted once the handler is done, and any failure is swallowed.
 * No IP is stored: the distinct id is a daily hash of the user agent, and
 * the event asks PostHog not to create a person profile.
 *
 * What an event counts depends on the route's caching: the Markdown route
 * is uncached and emits one event per read; /api/stat (60 s edge TTL) and
 * /api/citable (one hour) emit one per cache fill, so those two are
 * samples, not totals. Staging builds carry the production key; `$host`
 * is set so the CRM's host filter (crm/lib/traffic.ts) separates them,
 * as it does for the client events. The nightly HF publisher reads
 * /api/stat for every bench with a fixed user agent (scripts/hf_publisher),
 * filter it on `$useragent` in a dashboard.
 */

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const HOST = "https://us.i.posthog.com";

// The AI crawlers come first and come from src/data/ai-crawlers.ts, because
// almost all of them put `Mozilla/5.0` in their own user-agent: an AI entry
// placed after the browser catch-all below would be counted as a browser. The
// hand-written half of this table had drifted from the allow list anyway, and
// ExaSearchBot, the biggest crawler on the site, was landing in "other".
const FAMILIES: [RegExp, string][] = [
  ...AI_CRAWLER_FAMILIES,
  // Search engines and plain HTTP clients. Not AI, so not in that list.
  [/Googlebot|Google-InspectionTool/i, "googlebot"],
  [/bingbot/i, "bingbot"],
  [/Applebot/i, "applebot"],
  [/DuckDuckBot/i, "duckduckgo"],
  [/PetalBot/i, "petalbot"],
  [/Baiduspider/i, "baiduspider"],
  [/YandexBot/i, "yandexbot"],
  // Commercial SEO tools, deliberately not allowlisted but worth naming so
  // they stop inflating "other".
  [/AhrefsBot|AhrefsSiteAudit/i, "ahrefs"],
  [/Semrush/i, "semrush"],
  [/Barkrowler/i, "barkrowler"],
  [/facebookexternalhit|Twitterbot/i, "unfurler"],
  [/curl\//i, "curl"],
  [/python-requests|httpx|aiohttp/i, "python"],
  [/node-fetch|undici|axios/i, "node"],
  [/Go-http-client/i, "go"],
  [/Mozilla\//i, "browser"],
];

/** Coarse user-agent family, so a dashboard can split agents from browsers
 *  without storing the raw string as a dimension. */
export function uaFamily(ua: string): string {
  if (!ua) return "empty";
  for (const [re, name] of FAMILIES) if (re.test(ua)) return name;
  return "other";
}

/** Queue one server event for the current request. Safe to call when the
 *  key is absent (local dev): it does nothing. */
export function captureServer(req: Request, event: string, props: Record<string, unknown>): void {
  if (!KEY) return;
  const ua = req.headers.get("user-agent") ?? "";
  const accept = req.headers.get("accept") ?? "";
  const referer = req.headers.get("referer") ?? "";
  const url = new URL(req.url);
  const day = new Date().toISOString().slice(0, 10);
  const distinctId = "srv:" + createHash("sha256").update(`${ua}|${day}`).digest("hex").slice(0, 16);
  const body = {
    api_key: KEY,
    event,
    distinct_id: distinctId,
    timestamp: new Date().toISOString(),
    properties: {
      ...props,
      $lib: "ocb-server",
      $process_person_profile: false,
      $host: url.host,
      $current_url: `${url.origin}${url.pathname}`,
      env: process.env.VERCEL_ENV ?? "local",
      ua_family: uaFamily(ua),
      $useragent: ua.slice(0, 200),
      accept: accept.slice(0, 120),
      $referrer: referer.slice(0, 200),
    },
  };
  after(async () => {
    try {
      await fetch(`${HOST}/i/v0/e/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // analytics never fails a response
    }
  });
}
