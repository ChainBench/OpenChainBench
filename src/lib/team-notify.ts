import { causeCode } from "@/lib/error-cause";

const TELEGRAM_MAX_CHARS = 4096;
const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_LOGGED_ERROR = 200;

const FORMAT_CHARS =
  "\\u2028\\u2029\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060\\ufeff";
const CONTROL_CHARS = new RegExp(
  `[\\u0000-\\u001f\\u007f${FORMAT_CHARS}]`,
  "g",
);
const CONTROL_CHARS_KEEP_NL = new RegExp(
  `[\\u0000-\\u0009\\u000b-\\u001f\\u007f${FORMAT_CHARS}]`,
  "g",
);

export type TeamMessage = {
  telegramHtml: string;
  slack: { text: string; blocks: unknown[] };
};

export type TeamDelivery = "sent" | "failed" | "unconfigured";

type Channel =
  | { kind: "telegram"; token: string; chat: string }
  | { kind: "slack"; webhook: string };

function channel(): Channel | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (token && chat) return { kind: "telegram", token, chat };
  const webhook = process.env.SLACK_REPORT_WEBHOOK_URL;
  return webhook ? { kind: "slack", webhook } : null;
}

export function teamChannelConfigured(): boolean {
  return channel() !== null;
}

function defangUrls(s: string): string {
  return s.replace(
    /\b(https?|ftp|mailto|tel|javascript|data|file)(:)/gi,
    "$1[:]",
  );
}

export function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function neutralise(s: string): string {
  return escapeHtmlText(s)
    .replace(/([`*_~|])/g, "\u200b$1")
    .replace(/@(channel|here|everyone)/gi, "@\u200b$1");
}

const HALF_CHARACTER_AT_END = /[\uD800-\uDBFF]$/;

function cutWithin(s: string, max: number): string {
  const cut = s.slice(0, max);
  return HALF_CHARACTER_AT_END.test(cut) ? cut.slice(0, -1) : cut;
}

function escapedWithin(s: string, max: number): string {
  const escaped = defangUrls(neutralise(s.trim()));
  const cut = cutWithin(escaped, max);
  const amp = cut.lastIndexOf("&");
  const open = amp >= 0 && !cut.includes(";", amp);
  return (open ? cut.slice(0, amp) : cut).trimEnd();
}

export function escapeForTeam(s: string, max: number): string {
  const flat = s.normalize("NFKC").replace(CONTROL_CHARS, " ");
  return escapedWithin(flat, max);
}

export function escapeForTeamMultiline(s: string, max: number): string {
  const kept = s
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS_KEEP_NL, " ");
  return escapedWithin(kept, max);
}

async function telegramError(res: Response, token: string): Promise<string> {
  const answer: unknown = await res.json().catch(() => null);
  if (typeof answer !== "object" || answer === null) return "";
  if (!("description" in answer)) return "";
  const { description } = answer;
  return typeof description === "string"
    ? description.replaceAll(token, "[token]").slice(0, MAX_LOGGED_ERROR)
    : "";
}

function errorName(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const code = causeCode(err);
  return code ? `${err.name} ${code}` : err.name;
}

async function sendTelegram(
  to: { token: string; chat: string },
  html: string,
): Promise<TeamDelivery> {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${to.token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: to.chat,
          text: cutWithin(html, TELEGRAM_MAX_CHARS),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      },
    );
    if (res.ok) return "sent";
    console.error(
      "Telegram rejected team message",
      res.status,
      await telegramError(res, to.token),
    );
    return "failed";
  } catch (err) {
    console.error("Telegram sendMessage failed", errorName(err));
    return "failed";
  }
}

async function sendSlack(
  webhook: string,
  payload: TeamMessage["slack"],
): Promise<TeamDelivery> {
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (res.ok) return "sent";
    const text = await res.text().catch(() => "");
    console.error("Slack webhook rejected team message", res.status, text);
    return "failed";
  } catch (err) {
    const detail = err instanceof Error ? err.message : "";
    console.error("Slack webhook fetch failed", errorName(err),
      detail.replaceAll(webhook, "[webhook]").slice(0, MAX_LOGGED_ERROR));
    return "failed";
  }
}

export async function notifyTeam(message: TeamMessage): Promise<TeamDelivery> {
  const to = channel();
  if (!to) return "unconfigured";
  if (to.kind === "telegram") return sendTelegram(to, message.telegramHtml);
  return sendSlack(to.webhook, message.slack);
}
