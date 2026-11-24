import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { stubTeamChannel } from "@/test/team-channel";
import { POST } from "./route";

const channel = stubTeamChannel();
const sent = () => channel.calls.map((c) => String(c.body.text));
let ip = 0;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123:secret";
  process.env.TELEGRAM_CHAT_ID = "-42";
});

function report(
  headers: Record<string, string> = {},
  fields: Record<string, string> = {},
) {
  ip += 1;
  return POST(new Request("http://localhost/api/report", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vercel-forwarded-for": `198.51.100.${ip}`,
      ...headers,
    },
    body: JSON.stringify({
      slug: "ethereum-rpc",
      message: 'Wrong value <a href="https://evil.example">here</a> @channel',
      ...fields,
    }),
  }));
}

describe("benchmark report", () => {
  test("reaches the team with the visitor's text made inert", async () => {
    const res = await report(
      {
        "user-agent": "<b>bot</b>",
        referer: "javascript:alert(1)",
        "x-forwarded-for": "<u>203.0.113.7</u>",
      },
      { contact: '<a href="https://phish.example">CRM</a>' },
    );
    expect(res.status).toBe(200);
    expect(sent()).toHaveLength(1);
    const text = sent()[0] ?? "";
    expect(text).not.toContain("<a href");
    expect(text).not.toContain("<b>bot</b>");
    expect(text).not.toContain("<u>203.0.113.7</u>");
    expect(text).not.toContain("https://phish");
    expect(text).toContain("&lt;a href");
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("@channel");
  });

  test("a delivery the team channel refuses is a 502", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    channel.status = 500;
    try {
      const res = await report();
      expect(res.status).toBe(502);
    } finally {
      logged.mockRestore();
    }
  });
});
