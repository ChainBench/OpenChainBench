import { NextResponse } from "next/server";
import { clientKey, globalLimit, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { CHAIN_RE, SLUG_RE } from "@/lib/slug";

export const runtime = "nodejs";

const MAX_MESSAGE = 2000;
const MAX_CONTACT = 200;
const MAX_HEADER_ECHO = 200;

// C0 control characters + DEL + the Unicode "line/paragraph separator"
// characters that Slack renders as newlines (U+2028, U+2029), plus the
// bidi/format chars that visually rearrange text (U+200B-U+200F,
// U+202A-U+202E, U+2060, U+FEFF). Stripped from every user-controlled
// string before it hits a Slack mrkdwn field. KEEP_NL preserves \n
// (U+000A) so the report body can still have paragraphs.
const CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u001f\\u007f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2060\\ufeff]",
  "g",
);
const CONTROL_CHARS_KEEP_NL = new RegExp(
  "[\\u0000-\\u0009\\u000b-\\u001f\\u007f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2060\\ufeff]",
  "g",
);

/** Defang bare URLs so Slack doesn't auto-link them. Reporter abusing the
 *  endpoint can otherwise inject phishing URLs that render as clickable
 *  links in the on-call channel. Replace `:` after any URL-ish scheme. */
function defangUrls(s: string): string {
  return s.replace(/\b(https?|ftp|mailto|tel|javascript|data|file)(:)/gi, "$1[:]");
}

/** Neutralise Slack mrkdwn so user-supplied strings can't inject mentions
 *  (`<@U123>`, `<!channel>`), link cloaking (`<https://evil|safe>`), code
 *  blocks (``` ``` ``` ```), or bold/italic/strike formatting that would
 *  let a reporter forge fake "*IP:* / *Contact:*" lines in the webhook. */
function slackSafe(s: string, max: number): string {
  // NFKC normalize first so Unicode-confusable variants (combining marks,
  // compatibility forms) collapse to ASCII-equivalents the mention regex
  // catches.
  const normalized = s
    .normalize("NFKC")
    .replace(CONTROL_CHARS, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([`*_~|])/g, "​$1")
    .replace(/@(channel|here|everyone)/gi, "@​$1");
  return defangUrls(normalized).slice(0, max).trim();
}

/** Multiline variant: preserves \n so report bodies can use paragraphs. */
function slackSafeMultiline(s: string, max: number): string {
  const normalized = s
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS_KEEP_NL, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([`*_~|])/g, "​$1")
    .replace(/@(channel|here|everyone)/gi, "@​$1");
  return defangUrls(normalized).slice(0, max).trim();
}

type Body = {
  slug?: unknown;
  chain?: unknown;
  message?: unknown;
  contact?: unknown;
  page?: unknown;
};

export async function POST(req: Request) {
  // Per-IP cap (anti-burst per actor) AND site-wide cap (anti-amplification
  // from a swarm of cheap residential IPs - even when each stays under the
  // per-IP limit, the global bucket bounds total Slack webhook fan-out).
  const rl = rateLimit(clientKey(req, "report"), 5, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);
  const gl = globalLimit("report", 60, 60);
  if (!gl.ok) return tooManyRequests(gl.retryAfterSec);

  const webhook = process.env.SLACK_REPORT_WEBHOOK_URL;
  if (!webhook) {
    return NextResponse.json(
      { error: "Reporting is not configured." },
      { status: 503 }
    );
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const slug = typeof body.slug === "string" ? body.slug.slice(0, 80) : "";
  const chain =
    typeof body.chain === "string" && body.chain ? body.chain.slice(0, 40) : null;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const contact =
    typeof body.contact === "string" && body.contact
      ? body.contact.trim().slice(0, MAX_CONTACT)
      : null;
  const page = typeof body.page === "string" ? body.page.slice(0, 500) : "";

  if (!slug || !SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Invalid slug." }, { status: 400 });
  }
  if (chain != null && !CHAIN_RE.test(chain)) {
    return NextResponse.json({ error: "Invalid chain." }, { status: 400 });
  }
  if (message.length < 5) {
    return NextResponse.json(
      { error: "Message is too short. Tell us a bit more." },
      { status: 400 }
    );
  }
  if (message.length > MAX_MESSAGE) {
    return NextResponse.json(
      { error: `Message exceeds ${MAX_MESSAGE} characters.` },
      { status: 400 }
    );
  }

  const ua = slackSafe(req.headers.get("user-agent") ?? "unknown", MAX_HEADER_ECHO);
  const referer = slackSafe(
    req.headers.get("referer") ?? page ?? "unknown",
    MAX_HEADER_ECHO,
  );
  const ip = slackSafe(
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown",
    64,
  );

  const safeSlug = slackSafe(slug, 80);
  const safeChain = chain ? slackSafe(chain, 40) : null;
  const safeMessage = slackSafeMultiline(message, MAX_MESSAGE);
  const safeContact = contact ? slackSafe(contact, MAX_CONTACT) : null;

  const titleLine = safeChain ? `${safeSlug} · chain ${safeChain}` : safeSlug;
  const slackPayload = {
    text: `New benchmark report · ${titleLine}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🐞 New OpenChainBench report",
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Bench*\n\`${titleLine}\`` },
          { type: "mrkdwn", text: `*Page*\n${referer}` },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Message*\n${safeMessage}` },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*Contact:* ${safeContact ?? "_not provided_"} · *IP:* ${ip} · *UA:* ${ua}`,
          },
        ],
      },
    ],
  };

  try {
    const slackRes = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slackPayload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!slackRes.ok) {
      const text = await slackRes.text().catch(() => "");
      console.error("Slack webhook rejected report", slackRes.status, text);
      return NextResponse.json(
        { error: "Could not deliver the report. Try again in a moment." },
        { status: 502 }
      );
    }
  } catch (err) {
    console.error("Slack webhook fetch failed", err);
    return NextResponse.json(
      { error: "Could not reach Slack." },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
