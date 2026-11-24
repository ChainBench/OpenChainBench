import { NextResponse } from "next/server";
import { clientKey, globalLimit, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { CHAIN_RE, SLUG_RE } from "@/lib/slug";
import {
  escapeForTeam,
  escapeForTeamMultiline,
  notifyTeam,
  teamChannelConfigured,
} from "@/lib/team-notify";

export const runtime = "nodejs";

const MAX_MESSAGE = 2000;
const MAX_CONTACT = 200;
const MAX_HEADER_ECHO = 200;

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

  if (!teamChannelConfigured()) {
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

  const ua = escapeForTeam(
    req.headers.get("user-agent") ?? "unknown",
    MAX_HEADER_ECHO,
  );
  const referer = escapeForTeam(
    req.headers.get("referer") ?? page ?? "unknown",
    MAX_HEADER_ECHO,
  );
  const ip = escapeForTeam(
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown",
    64,
  );

  const safeSlug = escapeForTeam(slug, 80);
  const safeChain = chain ? escapeForTeam(chain, 40) : null;
  const safeMessage = escapeForTeamMultiline(message, MAX_MESSAGE);
  const safeContact = contact ? escapeForTeam(contact, MAX_CONTACT) : null;

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

  const delivery = await notifyTeam({
    telegramHtml:
      `\u{1F41E} <b>New OpenChainBench report</b>\n\n` +
      `<b>Bench</b> <code>${titleLine}</code>\n` +
      `<b>Page</b> ${referer}\n\n` +
      `${safeMessage}\n\n` +
      `<i>Contact: ${safeContact ?? "not provided"}</i>\n` +
      `<i>IP: ${ip}</i>\n` +
      `<i>UA: ${ua}</i>`,
    slack: slackPayload,
  });
  if (delivery !== "sent") {
    return NextResponse.json(
      { error: "Could not deliver the report. Try again in a moment." },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true });
}
