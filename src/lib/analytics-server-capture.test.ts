import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import "@/test/after-queue";
import { posthogCookie } from "@/test/posthog-cookie";

const KEY = "phc_test";
const VISITOR_COOKIE = posthogCookie(`ph_${KEY}_posthog`, {
  distinct_id: "0193-visitor",
  $sesid: [Date.now(), "0193-session", Date.now()],
});

const FRESH_INSTANCE = "./analytics-server?capture";
const sent = spyOn(globalThis, "fetch");
process.env.NEXT_PUBLIC_POSTHOG_KEY = KEY;
const { captureServer, readSiteVisitors }: typeof import("./analytics-server") =
  await import(FRESH_INSTANCE);

beforeEach(() => {
  sent.mockReset();
  sent.mockResolvedValue(new Response(null));
});

afterAll(() => {
  sent.mockRestore();
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
});

function sentEvent(): Record<string, unknown> {
  const init = sent.mock.calls[0]?.[1];
  if (typeof init?.body !== "string") throw new Error("nothing sent");
  return JSON.parse(init.body);
}

function request(cookie: string | null): Request {
  return new Request("https://openchainbench.com/go?to=x", {
    headers: { "user-agent": "Mozilla/5.0", ...(cookie ? { cookie } : {}) },
  });
}

test("attributes a visitor event to the browser's PostHog id", () => {
  const req = request(VISITOR_COOKIE);
  const [visitor] = readSiteVisitors(req);
  captureServer(req, "outbound_click", {}, visitor ?? null);
  const event = sentEvent();
  expect(event.distinct_id).toBe("0193-visitor");
  expect(event.properties).toMatchObject({
    $session_id: "0193-session",
    visitor_source: "posthog",
  });
});

test("attributes a visitor event to the redirect cookie", () => {
  const visitor = {
    distinctId: "0b7d-reader",
    sessionId: null,
    source: "go",
  } as const;
  captureServer(request(null), "outbound_click", {}, visitor);
  const event = sentEvent();
  expect(event.distinct_id).toBe("0b7d-reader");
  expect(event.properties).toMatchObject({ visitor_source: "go" });
  expect(event.properties).not.toHaveProperty("$session_id");
});

test("uses the agent hash for events without a visitor", () => {
  captureServer(request(VISITOR_COOKIE), "stat_read", {});
  const event = sentEvent();
  expect(event.distinct_id).toMatch(/^srv:[0-9a-f]{16}$/);
  expect(event.properties).not.toHaveProperty("visitor_source");
});
