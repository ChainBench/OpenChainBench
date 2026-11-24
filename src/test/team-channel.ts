import { afterEach, beforeEach, type Mock, spyOn } from "bun:test";
import { z } from "zod";
import { isolateEnv } from "./env";

export const TELEGRAM_LIMIT = 4096;

const TEAM_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "SLACK_REPORT_WEBHOOK_URL",
];
const postedSchema = z.record(z.string(), z.unknown());

type TeamCall = { url: string; body: Record<string, unknown> };
type TeamChannel = {
  calls: TeamCall[];
  status: number;
  offline: boolean;
  timeout: boolean;
  answer: string;
};

export function stubTeamChannel(): TeamChannel {
  isolateEnv(TEAM_ENV);
  const channel: TeamChannel = {
    calls: [],
    status: 200,
    offline: false,
    timeout: false,
    answer: "{}",
  };
  let fetchSpy: Mock<typeof fetch> | null = null;
  beforeEach(() => {
    Object.assign(channel, {
      calls: [],
      status: 200,
      offline: false,
      timeout: false,
      answer: "{}",
    });
    const post = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (channel.offline) throw new TypeError(`fetch failed: ${String(input)}`);
      if (channel.timeout) throw new DOMException("timed out", "TimeoutError");
      const body = postedSchema.parse(JSON.parse(String(init?.body)));
      channel.calls.push({ url: String(input), body });
      return new Response(channel.answer, { status: channel.status });
    };
    const { preconnect } = globalThis.fetch;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(post, { preconnect }),
    );
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
  });
  return channel;
}
