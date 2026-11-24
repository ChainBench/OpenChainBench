import { describe, expect, test } from "bun:test";
import {
  APPROVED_REQUEST,
  PENDING_REQUEST,
  reach,
} from "@/test/access-request-fixtures";
import { type AccessRequest, withKey } from "./access-request";
import { requesterView } from "./requester-view";
import {
  type Answer,
  type ApprovedView,
  type KeyOutcome,
  isView,
  keyChangedElsewhere,
  keyOutcome,
  keyRequest,
  shownKey,
  type Trouble,
  troubleOf,
} from "./status-answers";

const keyed = withKey(APPROVED_REQUEST,
  { hash: "b".repeat(64), last4: "Ab3d", createdAt: 3 });

const requests: [string, AccessRequest][] = [
  ["pending", PENDING_REQUEST],
  ["approved without a key", APPROVED_REQUEST],
  ["approved with a key", keyed],
  ["declined", reach([{ to: "declined", reason: "No site." }])],
  ["revoked", reach([{ to: "revoked" }], keyed)],
];

const viewOf = (req: AccessRequest) =>
  Object.fromEntries(Object.entries(requesterView(req)));
const without = (view: Record<string, unknown>, field: string) =>
  Object.fromEntries(Object.entries(view).filter(([f]) => f !== field));

describe("status page reading the server's view", () => {
  for (const [name, request] of requests) {
    test(`accepts a ${name} view`, () => {
      const view = JSON.parse(JSON.stringify(requesterView(request)));
      expect(isView(view)).toBe(true);
      expect(shownKey({ key: "ocb_x", view })).toEqual({ key: "ocb_x", view });
    });
  }

  test("refuses a view that does not match its state", () => {
    const approvedView = viewOf(keyed);
    const declinedView = viewOf(reach([{ to: "declined", reason: "No." }]));
    const revokedView = viewOf(reach([{ to: "revoked" }], keyed));
    const cases: [string, unknown][] = [
      ["approved without its date", without(approvedView, "approvedAt")],
      ["approved with a broken key",
        { ...approvedView, key: { last4: "Ab3d" } }],
      ["declined without a reason", without(declinedView, "reason")],
      ["revoked with a broken key", { ...revokedView, lastKey: "Ab3d" }],
      ["an unknown state", { ...approvedView, status: "paused" }],
    ];
    for (const [name, view] of cases) {
      expect([name, isView(view)]).toEqual([name, false]);
    }
  });

  test("refuses a new key that is not text", () => {
    expect(shownKey({ key: 42, view: viewOf(keyed) })).toBeNull();
    expect(shownKey({ view: viewOf(keyed) })).toBeNull();
  });
});

describe("status page reading a refusal", () => {
  const cases: [Answer, Trouble][] = [
    [{ status: 404, body: { error: "unknown_link" } },
      { kind: "unknown_link" }],
    [{ status: 404, body: null }, { kind: "failed" }],
    [{ status: 429, body: { retryAfterSec: 90 } },
      { kind: "limited", seconds: 90 }],
    [{ status: 429, body: { retryAfterSec: -5 } },
      { kind: "limited", seconds: 60 }],
    [{ status: 429, body: null }, { kind: "limited", seconds: 60 }],
    [{ status: 503, body: { error: "busy", retryAfterSec: 30 } },
      { kind: "busy", seconds: 30 }],
    [{ status: 503, body: { error: "unavailable" } }, { kind: "failed" }],
    [{ status: 500, body: { error: "unreadable" } }, { kind: "unreadable" }],
    [{ status: 500, body: "<html>" }, { kind: "failed" }],
    [{ status: 0, body: null }, { kind: "failed" }],
  ];
  test.each(cases)("%o reads as %o", (answer, trouble) => {
    expect(troubleOf(answer)).toEqual(trouble);
  });
});

describe("status page creating a key", () => {
  const approvedView = (request: AccessRequest): ApprovedView => {
    const view = requesterView(request);
    if (view.status !== "approved") throw new Error("not approved");
    return view;
  };

  test("a replacement names the key it replaces", () => {
    expect(keyRequest(approvedView(keyed), "t"))
      .toEqual({ token: "t", replacing: "Ab3d" });
    expect(keyRequest(approvedView(APPROVED_REQUEST), "t"))
      .toEqual({ token: "t", replacing: null });
  });

  const view = requesterView(keyed);
  const cases: [string, Answer, KeyOutcome][] = [
    ["a new key", { status: 201, body: { key: "ocb_x", view } },
      { kind: "shown", shown: { key: "ocb_x", view } }],
    ["a request that changed meanwhile",
      { status: 409, body: { error: "key_changed" } }, { kind: "changed" }],
    ["a created key that cannot be read", { status: 201, body: {} },
      { kind: "trouble", trouble: { kind: "failed" } }],
    ["an unknown link", { status: 404, body: { error: "unknown_link" } },
      { kind: "trouble", trouble: { kind: "unknown_link" } }],
    ["a missing route", { status: 404, body: null },
      { kind: "trouble", trouble: { kind: "failed" } }],
  ];
  test.each(cases)("%s", (_, answer, outcome) => {
    expect(keyOutcome(answer)).toEqual(outcome);
  });

  const revoked = reach([{ to: "revoked" }], keyed);
  const changes: [string, AccessRequest, string | null, boolean][] = [
    ["a key created in another tab", keyed, null, true],
    ["a key replaced in another tab", keyed, "Zz99", true],
    ["the same key, another change", keyed, "Ab3d", false],
    ["a revocation", revoked, "Ab3d", false],
  ];
  test.each(changes)("%s", (_, request, replacing, elsewhere) => {
    const sent = { token: "t", replacing };
    expect(keyChangedElsewhere(requesterView(request), sent))
      .toBe(elsewhere);
  });
});
