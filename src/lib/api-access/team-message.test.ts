import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { TELEGRAM_LIMIT } from "@/test/team-channel";
import { MAX_USE_CASE } from "./contract";
import { newRequestMessage } from "./team-message";

const SLACK_TEXT_MAX_CHARS = 3000;
const SLACK_FIELD_MAX_CHARS = 2000;

const slackText = z.object({ type: z.string(), text: z.string() });
const slackBlocks = z.array(z.object({
  text: slackText.optional(),
  fields: z.array(slackText).optional(),
}));

function slackTexts(blocks: unknown[], type: "plain_text" | "mrkdwn") {
  return slackBlocks
    .parse(blocks)
    .flatMap((b) => [...(b.text ? [b.text] : []), ...(b.fields ?? [])])
    .filter((t) => t.type === type)
    .map((t) => t.text);
}

const shownBySlack = (s: string) =>
  s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

const hostile = {
  name: '<a href="https://evil.example">Open CRM</a> @channel',
  email: "x@evil.example",
  website: "https://evil.example/<b>",
  useCase: "<b unclosed & *bold* https://evil.example ".repeat(30),
};

describe("new request message", () => {
  test("no requester field can add markup, mentions or links", () => {
    const { telegramHtml, slack } = newRequestMessage(hostile);
    const userText = telegramHtml.replace(/<\/?(b|i|code|pre)>/g, "");
    expect(userText).not.toContain("<");
    expect(userText).not.toContain("https:");
    expect(userText).not.toMatch(/@channel/);
    expect(slack.text).not.toContain("<");
    expect(slack.text).not.toContain("https:");
    expect(slack.text).not.toMatch(/@channel/);
    expect(JSON.stringify(slack.blocks)).not.toContain("<");
    expect(JSON.stringify(slack.blocks)).not.toContain("https:");
    expect(slackTexts(slack.blocks, "mrkdwn").join()).not.toContain("evil");
  });

  test("Slack shows every requester field as plain text, as typed", () => {
    const useCase = "```\n<!channel> *bold* _x_ ~y~ @here :rotating_light:";
    const requester = { ...hostile, name: "<b>R&D</b> @channel", useCase };
    const { slack } = newRequestMessage(requester);
    expect(slackTexts(slack.blocks, "plain_text").map(shownBySlack)).toEqual([
      requester.name,
      requester.email,
      "https[:]//evil.example/<b>",
      useCase,
    ]);
  });

  test("the longest use case stays within Telegram and Slack limits", () => {
    const requester = { ...hostile, useCase: "&<".repeat(MAX_USE_CASE) };
    const { telegramHtml, slack } = newRequestMessage(requester);
    expect(telegramHtml.length).toBeLessThan(TELEGRAM_LIMIT);
    expect(telegramHtml.endsWith("</i>")).toBe(true);
    const plain = slackTexts(slack.blocks, "plain_text");
    const shown = shownBySlack(plain.at(-1) ?? "");
    expect(requester.useCase.startsWith(shown)).toBe(true);
    for (const block of slackBlocks.parse(slack.blocks)) {
      if (block.text) {
        expect(block.text.text.length).toBeLessThan(SLACK_TEXT_MAX_CHARS);
      }
      for (const field of block.fields ?? []) {
        expect(field.text.length).toBeLessThan(SLACK_FIELD_MAX_CHARS);
      }
    }
  });

  test("the use case keeps its line breaks and its full length", () => {
    const useCase = `${"a_b ".repeat(MAX_USE_CASE / 4 - 3)}\nlast line`;
    const { telegramHtml } = newRequestMessage({ ...hostile, useCase });
    const shown = /<pre>([\s\S]*)<\/pre>/.exec(telegramHtml)?.[1] ?? "";
    expect(shown.replaceAll("\u200b", "")).toBe(useCase);
  });

  test("Telegram and Slack show the email exactly as typed", () => {
    const email = "o'brien_last*x@example.com";
    const { telegramHtml, slack } = newRequestMessage({ ...hostile, email });
    expect(telegramHtml).toContain(`<code>${email}</code>`);
    expect(slackTexts(slack.blocks, "plain_text")).toContain(email);
  });
});
