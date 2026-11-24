import { describe, expect, test } from "bun:test";
import { quietConsole } from "@/test/quiet-console";
import { TELEGRAM_LIMIT, stubTeamChannel } from "@/test/team-channel";
import {
  escapeForTeam,
  escapeForTeamMultiline,
  notifyTeam,
  type TeamDelivery,
  type TeamMessage,
} from "./team-notify";

const channel = stubTeamChannel();
const logs = quietConsole();

const SLACK_ENV = { SLACK_REPORT_WEBHOOK_URL: "https://hooks.example/slack" };

const message: TeamMessage = {
  telegramHtml: "x".repeat(5000),
  slack: { text: "slack text", blocks: [] },
};

describe("notifyTeam", () => {
  test("reports unconfigured without a channel", async () => {
    expect(await notifyTeam(message)).toBe("unconfigured");
    expect(channel.calls).toHaveLength(0);
  });

  test("prefers Telegram over Slack and caps the text", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:secret";
    process.env.TELEGRAM_CHAT_ID = "-42";
    process.env.SLACK_REPORT_WEBHOOK_URL = "https://hooks.example/slack";
    expect(await notifyTeam(message)).toBe("sent");
    expect(channel.calls).toHaveLength(1);
    expect(channel.calls[0]?.url).toContain("api.telegram.org/bot123:secret/");
    expect(channel.calls[0]?.body.parse_mode).toBe("HTML");
    expect(String(channel.calls[0]?.body.text)).toHaveLength(TELEGRAM_LIMIT);
  });

  test("the Telegram cut never splits an emoji", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:secret";
    process.env.TELEGRAM_CHAT_ID = "-42";
    const telegramHtml = `${"x".repeat(TELEGRAM_LIMIT - 1)}\u{1f680}x`;
    expect(await notifyTeam({ ...message, telegramHtml })).toBe("sent");
    const text = String(channel.calls[0]?.body.text);
    expect(text).toBe("x".repeat(TELEGRAM_LIMIT - 1));
  });

  test("falls back to Slack when Telegram lacks its chat", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:secret";
    process.env.SLACK_REPORT_WEBHOOK_URL = "https://hooks.example/slack";
    expect(await notifyTeam(message)).toBe("sent");
    expect(channel.calls[0]?.url).toBe("https://hooks.example/slack");
    expect(channel.calls[0]?.body.text).toBe("slack text");
  });

  const TELEGRAM = {
    TELEGRAM_BOT_TOKEN: "123:secret",
    TELEGRAM_CHAT_ID: "-42",
  };
  const failures: [string, Record<string, string>, object, TeamDelivery][] = [
    ["Slack answers 500", SLACK_ENV, { status: 500 }, "failed"],
    ["Slack cannot be reached", SLACK_ENV, { offline: true }, "failed"],
    ["Telegram cannot be reached", TELEGRAM, { offline: true }, "failed"],
    ["Slack answers 400", SLACK_ENV, { status: 400 }, "refused"],
    ["Telegram answers 403", TELEGRAM, { status: 403 }, "refused"],
    ["Slack times out", SLACK_ENV, { timeout: true }, "unsure"],
    ["Telegram times out", TELEGRAM, { timeout: true }, "unsure"],
  ];
  test.each(failures)("%s: reports %s", async (_, env, fault, delivery) => {
    Object.assign(process.env, env);
    Object.assign(channel, fault);
    expect(await notifyTeam(message)).toBe(delivery);
  });

  test("logs Telegram's refusal without the bot token", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:secret";
    process.env.TELEGRAM_CHAT_ID = "-42";
    channel.status = 401;
    channel.answer = JSON.stringify({
      ok: false,
      description: "Unauthorized: bot123:secret is not valid",
    });
    expect(await notifyTeam(message)).toBe("refused");
    expect(logs.errors()).toHaveBeenCalled();
    expect(JSON.stringify(logs.errors().mock.calls))
      .not.toContain("123:secret");
  });
});

test("logs Slack's failure without the webhook address", async () => {
  Object.assign(process.env, SLACK_ENV);
  channel.offline = true;
  expect(await notifyTeam(message)).toBe("failed");
  const logged = JSON.stringify(logs.errors().mock.calls);
  expect(logged).toContain("fetch failed: [webhook]");
  expect(logged).not.toContain("hooks.example");
});

describe("escapeForTeam", () => {
  test("neutralises mentions, markup and links", () => {
    const out = escapeForTeam("<@U1> @channel *bold* https://evil", 200);
    expect(out).toBe(
      "&lt;@U1&gt; @\u200bchannel \u200b*bold\u200b* https[:]//evil",
    );
  });

  const neutralised: [string, string, string][] = [
    ["a forged line", "me\nIP: 1.2.3.4", "me IP: 1.2.3.4"],
    ["@here", "hi @here", "hi @\u200bhere"],
    ["@everyone", "@Everyone now", "@\u200bEveryone now"],
    ["a full-width @channel", "\uff20channel", "@\u200bchannel"],
  ];
  test.each(neutralised)("neutralises %s", (_, input, expected) => {
    expect(escapeForTeam(input, 200)).toBe(expected);
  });

  test("escaping never cuts inside an entity",
    () => {
      expect(escapeForTeam("R&D ".repeat(5), 6)).toBe("R&amp;");
      expect(escapeForTeam("<".repeat(10), 7)).toBe("&lt;");
    });

  test("joiners inside names and emoji are kept", () => {
    const persian = "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645";
    const name = `${persian} \u{1f469}\u200d\u{1f4bb}`;
    expect(escapeForTeam(name, 100)).toBe(name);
  });

  test("a cut never splits an emoji", () => {
    expect(escapeForTeam("ab\u{1f680}cd", 3)).toBe("ab");
    expect(escapeForTeam("ab\u{1f680}cd", 4)).toBe("ab\u{1f680}");
  });

  test("multiline text keeps line breaks and drops controls", () => {
    const text = "one\r\ntwo\u202ethree\u2028four\u0007five";
    expect(escapeForTeamMultiline(text, 100))
      .toBe("one\ntwo three four five");
  });
});
