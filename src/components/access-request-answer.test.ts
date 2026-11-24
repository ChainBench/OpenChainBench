import { expect, test } from "bun:test";
import { TEST_REQUESTER } from "@/test/access-request-fixtures";
import { type Editing, refusalFor } from "./access-request-answer";

const sent = {
  ...TEST_REQUESTER,
  email: "ana@exa\u200bmple.com",
  name: "Ana\u202eRibeiro",
  website: "htps://example.com\ufeff",
};

const cases: [string, number, unknown, Partial<Editing>][] = [
  ["named fields", 400, { error: "invalid", fields: ["name", "useCase"] },
    { invalid: ["name", "useCase"], pasted: ["name"], refusal: null }],
  ["a pasted email and a mistyped site", 400,
    { error: "invalid", fields: ["email", "website"] },
    { invalid: ["email", "website"], pasted: ["email"], refusal: null }],
  ["an unreadable body", 400, { error: "invalid", fields: [] },
    { invalid: [], refusal: { kind: "unreadable" } }],
  ["a network limit", 429, { retryAfterSec: 125 },
    { refusal: { kind: "limited", minutes: 3 } }],
  ["a busy site", 503, { error: "busy", retryAfterSec: 125 },
    { refusal: { kind: "busy", minutes: 3 } }],
  ["a full queue", 503, { error: "queue_full" },
    { refusal: { kind: "queue_full" } }],
  ["a store outage", 503, { error: "unavailable" },
    { refusal: { kind: "unconfirmed" } }],
  ["a store that never got the request", 503, { error: "not_saved" },
    { refusal: { kind: "not_saved" } }],
  ["a 400 of another shape", 400, { fields: "name" },
    { refusal: { kind: "unconfirmed" } }],
];

test.each(cases)("the form reads %s", (_, status, body, expected) => {
  expect(refusalFor(status, body, sent)).toMatchObject(expected);
});
