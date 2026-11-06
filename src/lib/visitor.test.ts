import { afterEach, expect, setSystemTime, test } from "bun:test";
import { newVisitor, readVisitors, visitorCookie } from "@/lib/visitor";
import { posthogCookie } from "@/test/posthog-cookie";

const NAME = "ph_phc_key_posthog";
const NOW = new Date("2026-11-06T12:00:00Z").getTime();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const READER = "0b7d1e6c-3f4a-4c1e-9a52-6f0e8d2b7c11";

function cookie(value: unknown, name = NAME): string {
  return `theme=dark; ${posthogCookie(name, value)}`;
}

afterEach(() => {
  setSystemTime();
});

test("reads the visitor and the session still in use", () => {
  setSystemTime(NOW);
  const header = cookie({
    distinct_id: "0193-visitor",
    $sesid: [NOW - 5 * MINUTE, "0193-session", NOW - 20 * MINUTE],
  });
  expect(readVisitors(header, NAME)).toEqual([
    {
      distinctId: "0193-visitor",
      sessionId: "0193-session",
      source: "posthog",
    },
  ]);
});

test.each([
  ["idle for more than thirty minutes", NOW - 31 * MINUTE, NOW - 40 * MINUTE],
  ["started more than a day ago", NOW - 5 * MINUTE, NOW - 25 * HOUR],
])("drops a session %s", (_name, lastActivity, start) => {
  setSystemTime(NOW);
  const header = cookie({
    distinct_id: "0193-visitor",
    $sesid: [lastActivity, "0193-session", start],
  });
  expect(readVisitors(header, NAME)).toEqual([
    { distinctId: "0193-visitor", sessionId: null, source: "posthog" },
  ]);
});

test("keeps the visitor when the session is malformed", () => {
  const header = cookie({ distinct_id: "0193-visitor", $sesid: "x" });
  const [visitor] = readVisitors(header, NAME);
  expect(visitor?.distinctId).toBe("0193-visitor");
});

test.each([
  ["no cookie header", null],
  ["another project's cookie", cookie({ distinct_id: "a" }, "ph_other")],
  ["broken encoding", `${NAME}=%E0%A4%A`],
  ["invalid JSON", `${NAME}=${encodeURIComponent("{")}`],
  ["no distinct id", cookie({ $sesid: [NOW, "s", NOW] })],
  ["an empty distinct id", cookie({ distinct_id: "" })],
  ["an oversized distinct id", cookie({ distinct_id: "a".repeat(201) })],
  ["a redirect cookie that is not a random id", "ocb_vid=everyone"],
])("reads no visitor from %s", (_name, header) => {
  expect(readVisitors(header, NAME)).toEqual([]);
});

test("falls back to the cookie set by the outbound redirect", () => {
  expect(readVisitors(`theme=dark; ocb_vid=${READER}`, NAME)).toEqual([
    { distinctId: READER, sessionId: null, source: "go" },
  ]);
});

test("lists the analytics cookie before the redirect cookie", () => {
  const header = `${cookie({ distinct_id: "0193-visitor" })}; ocb_vid=${READER}`;
  const sources = readVisitors(header, NAME).map((v) => v.source);
  expect(sources).toEqual(["posthog", "go"]);
});

test("reads the redirect cookie when analytics is not configured", () => {
  const [visitor] = readVisitors(`ocb_vid=${READER}`, null);
  expect(visitor?.distinctId).toBe(READER);
});

test("reads back the cookie it writes", () => {
  const visitor = newVisitor();
  const [pair] = visitorCookie(visitor).split(";");
  expect(readVisitors(pair ?? "", null)).toEqual([visitor]);
});
