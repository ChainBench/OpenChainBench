import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { TELEGRAM_LIMIT } from "@/test/team-channel";
import { MAX_USE_CASE } from "./contract";
import { newRequestMessage } from "./team-message";

const SLACK_TEXT_MAX_CHARS = 3000;
const SLACK_FIELD_MAX_CHARS = 2000;

const slackText = z.object({ text: z.string() });
const slackBlocks = z.array(z.object({
  text: slackText.optional(),
  fields: z.array(slackText).optional(),
}));

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
    const posted = JSON.stringify(slack);
    expect(posted).not.toContain("<");
    expect(posted).not.toContain("https:");
    expect(posted).not.toMatch(/@channel/);
  });

  test("backticks in the use case cannot close the Slack code block", () => {
    const useCase = "```\n<!channel> escaped ``` and more text here";
    const { slack } = newRequestMessage({ ...hostile, useCase });
    const [, block] = slackBlocks.parse(slack.blocks);
    const text = block?.text?.text ?? "";
    expect(text.match(/```/g)).toHaveLength(2);
  });

  test("the longest use case stays within Telegram and Slack limits", () => {
    const requester = { ...hostile, useCase: "&<".repeat(MAX_USE_CASE) };
    const { telegramHtml, slack } = newRequestMessage(requester);
    expect(telegramHtml.length).toBeLessThan(TELEGRAM_LIMIT);
    expect(telegramHtml.endsWith("</i>")).toBe(true);
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
    expect(JSON.stringify(slack)).toContain(`\`${email}\``);
  });
});
