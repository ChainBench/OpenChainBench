import { after } from "next/server";
import { createHash } from "node:crypto";

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
 */

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const HOST = "https://us.i.posthog.com";

const FAMILIES: [RegExp, string][] = [
  [/GPTBot/i, "gptbot"],
  [/ChatGPT-User/i, "chatgpt-user"],
  [/OAI-SearchBot/i, "oai-searchbot"],
  [/ClaudeBot|anthropic-ai/i, "claudebot"],
  [/Claude-User|Claude-SearchBot/i, "claude-user"],
  [/PerplexityBot/i, "perplexitybot"],
  [/Perplexity-User/i, "perplexity-user"],
  [/Google-Extended/i, "google-extended"],
  [/Googlebot|Google-InspectionTool/i, "googlebot"],
  [/bingbot/i, "bingbot"],
  [/Applebot/i, "applebot"],
  [/DuckAssistBot|DuckDuckBot/i, "duckduckgo"],
  [/CCBot/i, "ccbot"],
  [/Bytespider/i, "bytespider"],
  [/meta-externalagent|FacebookBot/i, "meta"],
  [/Amazonbot/i, "amazonbot"],
  [/cohere-ai/i, "cohere"],
  [/YouBot/i, "youbot"],
  [/MistralAI-User|Mistral/i, "mistral"],
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
