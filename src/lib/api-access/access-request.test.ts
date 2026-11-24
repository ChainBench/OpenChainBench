import { describe, expect, test } from "bun:test";
import {
  APPROVED_REQUEST,
  PENDING_REQUEST,
  reach,
} from "@/test/access-request-fixtures";
import {
  type AccessRequest,
  type Decision,
  decide,
  withKey,
  withToken,
} from "./access-request";

const pending = PENDING_REQUEST;

const approve: Decision = { to: "approved" };
const decline: Decision = { to: "declined", reason: "no site" };
const revoke: Decision = { to: "revoked" };

const states: [string, AccessRequest][] = [
  ["pending", pending],
  ["approved", reach([approve])],
  ["declined", reach([decline])],
  ["revoked", reach([approve, revoke])],
];
const allowed = new Set([
  "pending>approved",
  "pending>declined",
  "approved>revoked",
]);

describe("decide", () => {
  for (const [name, req] of states) {
    for (const d of [approve, decline, revoke]) {
      const edge = `${name}>${d.to}`;
      test(edge, () => {
        const out = decide(req, d, 3);
        expect(out.ok).toBe(allowed.has(edge));
        if (out.ok) {
          expect(out.next.status).toBe(d.to);
          expect(out.next.history.at(-1)).toEqual({
            event: d.to,
            at: 3,
            source: "team",
          });
        }
      });
    }
  }
});

describe("history", () => {
  test("keeps 50 events: the request and decisions, then the newest", () => {
    const keyed = [0, 1, 2, 3, 4].reduce(
      (req, i) => withKey(req, { hash: "b".repeat(64), last4: "abcd",
        createdAt: 10 + i }),
      APPROVED_REQUEST,
    );
    const relinked = Array.from({ length: 55 }, (_, i) => i)
      .reduce<AccessRequest>(
        (req, i) => withToken(req, "c".repeat(64), 15 + i),
        keyed,
      );
    const revoked = decide(relinked, revoke, 80);
    if (!revoked.ok) throw new Error("not revoked");
    const { history } = revoked.next;
    expect(history).toHaveLength(50);
    expect(history.slice(0, 2).map((c) => c.event))
      .toEqual(["requested", "approved"]);
    expect(history.at(-2)?.at).toBe(69);
    expect(history.at(-1)?.event).toBe("revoked");
    const later = Array.from({ length: 55 }, (_, i) => i)
      .reduce<AccessRequest>(
        (req, i) => withToken(req, "d".repeat(64), 81 + i),
        revoked.next,
      );
    expect(later.history).toHaveLength(50);
    expect(later.history.slice(0, 3).map((c) => c.event))
      .toEqual(["requested", "approved", "revoked"]);
  });
});
