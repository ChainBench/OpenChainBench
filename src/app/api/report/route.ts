import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_MESSAGE = 2000;
const MAX_CONTACT = 200;

type Body = {
  slug?: unknown;
  chain?: unknown;
  message?: unknown;
  contact?: unknown;
  page?: unknown;
};

export async function POST(req: Request) {
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

  const ua = req.headers.get("user-agent") ?? "unknown";
  const referer = req.headers.get("referer") ?? page ?? "unknown";
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  const titleLine = chain ? `${slug} · chain ${chain}` : slug;
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
        text: { type: "mrkdwn", text: `*Message*\n${message}` },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*Contact:* ${contact ?? "_not provided_"} · *IP:* ${ip} · *UA:* ${ua}`,
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
