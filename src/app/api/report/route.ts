import { NextResponse } from "next/server";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

const MAX_MESSAGE = 2000;
const MAX_CONTACT = 200;
const MAX_HEADER_ECHO = 200;

// C0 control characters + DEL. Stripped from every user-controlled string
// before it hits a Slack mrkdwn field. KEEP_NL preserves \n (U+000A) so
// the report body can still have paragraphs.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");
const CONTROL_CHARS_KEEP_NL = new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f]", "g");

/** Neutralise Slack mrkdwn so user-supplied strings can't inject mentions
 *  (`<@U123>`, `<!channel>`), link cloaking (`<https://evil|safe>`), or
 *  channel pings. Strips control chars (single-line variant) and escapes
 *  `<` `>` `&`. */
function slackSafe(s: string, max: number): string {
  return s
    .replace(CONTROL_CHARS, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, max)
    .trim();
}

/** Multiline variant: preserves \n so report bodies can use paragraphs. */
function slackSafeMultiline(s: string, max: number): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS_KEEP_NL, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, max)
    .trim();
}

type Body = {
  slug?: unknown;
  chain?: unknown;
  message?: unknown;
  contact?: unknown;
  page?: unknown;
};

export async function POST(req: Request) {
  const rl = rateLimit(clientKey(req, "report"), 5, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

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

  if (!slug) {
    return NextResponse.json({ error: "Missing slug." }, { status: 400 });
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
