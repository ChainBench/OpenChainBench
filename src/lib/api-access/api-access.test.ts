import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { RedisReplyError } from "@/lib/materialize/store";
import { sha256Hex } from "@/lib/sha256";
import { MS_PER_SECOND, SECONDS_PER_DAY } from "@/lib/time-constants";
import {
  TEST_NOW as NOW,
  approvedRequest,
  idForKey,
  issuedKey,
  openTestAccess,
  submittedRequest,
  useTestAccess,
} from "@/test/api-access-fixtures";
import { realRedisUrl } from "@/test/env";
import { TEST_REQUESTER } from "@/test/access-request-fixtures";
import { quietConsole } from "@/test/quiet-console";
import { openRequest } from "./access-request";
import { namespaceFor } from "./api-access";

quietConsole();

const LATER_MS = 1600;
const KEPT_SEC = 30 * SECONDS_PER_DAY;
const SOON_SEC = 100;
const NEARLY_EXPIRED_MS = 200;

test("staging and production keep their requests apart", () => {
  const built = { NODE_ENV: "production" };
  const staging = namespaceFor({ ...built, VERCEL_ENV: "preview" });
  const production = namespaceFor({ ...built, VERCEL_ENV: "production" });
  expect(production.startsWith(staging)).toBe(false);
  expect(staging.startsWith(production)).toBe(false);
});

describe.skipIf(!realRedisUrl)("api access on a real Redis", () => {
  const opened = useTestAccess();
  const { access } = opened;

  test("each status tab lists its own requests", async () => {
    const { id } = await approvedRequest(access);
    const approved = await access.list("approved", NOW);
    const pending = await access.list("pending", NOW);
    expect(approved.requests.map((r) => r.id)).toContain(id);
    expect(pending.requests.map((r) => r.id)).not.toContain(id);
    expect(approved.counts.approved).toBe(approved.requests.length);
    expect(pending.counts).toEqual(approved.counts);
    expect(pending.counts.pending).toBe(pending.requests.length);
  });

  test("each tab lists the newest request first", async () => {
    const own = openTestAccess();
    try {
      const submitAt = async (now: number) => {
        const sent = await own.access.submit(TEST_REQUESTER,
          { now, sender: randomUUID() });
        if (!sent.ok) throw new Error(sent.error);
        return sent.request.id;
      };
      const ids = async (status: "pending" | "approved") =>
        (await own.access.list(status, NOW)).requests.map((r) => r.id);
      const first = await submitAt(NOW);
      const third = await submitAt(NOW + 2);
      const second = await submitAt(NOW + 1);
      expect(await ids("pending")).toEqual([third, second, first]);
      await own.access.decideOn(third, { to: "approved" }, NOW + 5);
      await own.access.decideOn(first, { to: "approved" }, NOW + 10);
      expect(await ids("approved")).toEqual([third, first]);
      expect(await ids("pending")).toEqual([second]);
    } finally {
      await own.close();
    }
  });

  test("approving and declining at once lets exactly one through", async () => {
    const { request } = await submittedRequest(access);
    const outcomes = await Promise.all([
      access.decideOn(request.id, { to: "approved" }, NOW + 1),
      access.decideOn(request.id, { to: "declined", reason: "no site" }, NOW),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.find((o) => !o.ok)).toEqual({
      ok: false,
      error: "conflict",
    });
  });

  test("a declined request is deleted 30 days after the decision",
    async () => {
      const own = openTestAccess();
      try {
        const { token, request } = await submittedRequest(own.access);
        const { id } = request;
        await own.access.decideOn(id,
          { to: "declined", reason: "no site" }, NOW + 1);
        for (const left of await own.secondsLeft(id, token)) {
          expect(left).toBeGreaterThan(29 * SECONDS_PER_DAY);
          expect(left).toBeLessThanOrEqual(KEPT_SEC);
        }
        await own.expire(id, token);
        expect(await own.access.byToken(token)).toBeNull();
        const early = await own.access.list("declined", NOW + 1);
        expect(early.unreadable).toEqual([id]);
        const later = NOW + KEPT_SEC * MS_PER_SECOND;
        const old = await submittedRequest(own.access);
        await own.access.decideOn(old.request.id,
          { to: "declined", reason: "no site" }, later);
        const listed = await own.access.list("declined", later);
        expect(listed.unreadable).toEqual([]);
        expect(listed.requests.map((r) => r.id)).toEqual([old.request.id]);
        expect(listed.counts.declined).toBe(1);
      } finally {
        await own.close();
      }
    });

  test("a new link for a declined request expires with it", async () => {
    const { request } = await submittedRequest(access);
    await access.decideOn(request.id,
      { to: "declined", reason: "no site" }, NOW + 1);
    await opened.expireIn(request.id, SOON_SEC);
    const reissued = await access.reissueLink(request.id, NOW + 2);
    if (!reissued.ok) throw new Error(reissued.error);
    for (const left of await opened.secondsLeft(request.id, reissued.token)) {
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThanOrEqual(SOON_SEC);
    }
  });

  test("an approved request is kept", async () => {
    const { token, id } = await approvedRequest(access);
    expect(await opened.secondsLeft(id, token)).toEqual([-1, -1]);
  });

  test("two key creations at once keep only the key shown", async () => {
    const { token, id } = await approvedRequest(access);
    const both = await Promise.all([
      access.issueKey({ token, replacing: null, now: NOW + 2 }),
      access.issueKey({ token, replacing: null, now: NOW + 2 }),
    ]);
    const shown = both.flatMap((o) => (o.ok ? [o.key] : []));
    expect(shown).toHaveLength(1);
    expect(await idForKey(access, shown[0] ?? "")).toBe(id);
  });

  test("replacing the key stops the previous one", async () => {
    const { token, id, key } = await issuedKey(access);
    const first = await access.byToken(token);
    expect(first?.history.at(-1)?.event).toBe("key_created");
    const second = await access.issueKey(
      { token, replacing: key.slice(-4), now: NOW + 3 });
    if (!second.ok) throw new Error(second.error);
    expect(await idForKey(access, key)).toBeNull();
    expect(await idForKey(access, second.key)).toBe(id);
    const stored = await access.byToken(token);
    expect(stored?.history.at(-1)?.event).toBe("key_replaced");
  });

  test("only digests of the key and the status link are stored", async () => {
    const { token, key } = await issuedKey(access);
    const stored = await opened.storedText();
    expect(stored).toContain(sha256Hex(key));
    expect(stored).not.toContain(key);
    expect(stored).not.toContain(token);
  });

  test("revoking during a key creation keeps the index on the record",
    async () => {
      const { token, id } = await approvedRequest(access);
      const [revoked, issued] = await Promise.all([
        access.decideOn(id, { to: "revoked" }, NOW + 2),
        access.issueKey({ token, replacing: null, now: NOW + 2 }),
      ]);
      expect(revoked.ok && issued.ok).toBe(false);
      const stored = await access.byToken(token);
      const indexed = [...(await access.keyIndex()).values()].includes(id);
      expect(indexed).toBe(stored?.status === "approved");
    });

  test("an outdated page cannot replace the key in use", async () => {
    const { token, id, key } = await issuedKey(access);
    for (const replacing of [null, "zzzz"]) {
      expect(await access.issueKey({ token, replacing, now: NOW + 3 }))
        .toEqual({ ok: false, error: "key_changed" });
    }
    expect(await idForKey(access, key)).toBe(id);
  });

  test("revoking stops the key, its last four stay", async () => {
    const { token, id, key } = await issuedKey(access);
    const revoked = await access.decideOn(id, { to: "revoked" }, NOW + 3);
    expect(revoked.ok).toBe(true);
    expect(await idForKey(access, key)).toBeNull();
    const seen = await access.byToken(token);
    expect(seen?.status === "revoked" && seen.lastKey?.last4).toBe(
      key.slice(-4),
    );
    expect(await access.issueKey({ token, replacing: null, now: NOW + 4 }))
      .toEqual({ ok: false, error: "not_approved" });
  });

  test("a capped network waits until its first request's window ends",
    async () => {
      const cap = { sender: randomUUID(), perWindow: 2, windowSec: 120 };
      const fresh = () => openRequest({
        id: randomUUID(),
        requester: TEST_REQUESTER,
        tokenHash: sha256Hex(randomUUID()),
        now: NOW,
      });
      expect(await opened.store.insert(fresh(), cap)).toBe("stored");
      await Bun.sleep(LATER_MS);
      expect(await opened.store.insert(fresh(), cap)).toBe("stored");
      const capped = await opened.store.insert(fresh(), cap);
      if (typeof capped !== "object") throw new Error(`not capped: ${capped}`);
      expect(capped.waitSec).toBeGreaterThan(0);
      expect(capped.waitSec).toBeLessThan(cap.windowSec);
    });

  test("a capped network never waits zero seconds", async () => {
    const cap = { sender: randomUUID(), perWindow: 1, windowSec: 120 };
    const fresh = () => openRequest({
      id: randomUUID(),
      requester: TEST_REQUESTER,
      tokenHash: sha256Hex(randomUUID()),
      now: NOW,
    });
    expect(await opened.store.insert(fresh(), cap)).toBe("stored");
    await opened.expireSenderInMs(cap.sender, NEARLY_EXPIRED_MS);
    expect(await opened.store.insert(fresh(), cap)).toEqual({ waitSec: 1 });
  });

  test("the sending network is stored only as a digest", async () => {
    const sender = `198.51.100.${randomUUID()}`;
    const submitted = await access.submit(TEST_REQUESTER, { now: NOW, sender });
    expect(submitted.ok).toBe(true);
    const stored = await opened.storedText();
    expect(stored).toContain(sha256Hex(sender));
    expect(stored).not.toContain(sender);
  });

  test("a link replaced while it is being read is not found", async () => {
    let onPointerRead: (() => Promise<unknown>) | null = null;
    const raced = openTestAccess((transport) => ({
      ...transport,
      command: async (cmd, timeoutMs) => {
        const reply = await transport.command(cmd, timeoutMs);
        const hook = onPointerRead;
        if (cmd[0] === "GET" && hook) {
          onPointerRead = null;
          await hook();
        }
        return reply;
      },
    }));
    try {
      const { token, id } = await approvedRequest(raced.access);
      onPointerRead = () => raced.access.reissueLink(id, NOW + 5);
      expect(await raced.access.byToken(token)).toBeNull();
      expect(onPointerRead).toBeNull();
    } finally {
      await raced.close();
    }
  });

  test("the list shows when deleting old declines fails", async () => {
    const pruneRefused = openTestAccess((transport) => ({
      ...transport,
      command: (cmd, timeoutMs) =>
        cmd[0] === "ZRANGEBYSCORE"
          ? Promise.reject(new RedisReplyError("NOPERM no permission"))
          : transport.command(cmd, timeoutMs),
    }));
    try {
      const { request } = await submittedRequest(pruneRefused.access);
      const listed = await pruneRefused.access.list("pending", NOW);
      expect(listed.requests.map((r) => r.id)).toEqual([request.id]);
    } finally {
      await pruneRefused.close();
    }
  });

  test("a refusal other than WRONGTYPE is no unreadable record",
    async () => {
      const noPermission = () => new RedisReplyError("NOPERM no permission");
      const refusing = openTestAccess((transport) => ({
        command: (cmd, timeoutMs) =>
          cmd[0] === "HMGET"
            ? Promise.reject(noPermission())
            : transport.command(cmd, timeoutMs),
        pipeline: (cmds, timeoutMs) =>
          cmds.every((cmd) => cmd[0] === "HMGET")
            ? Promise.resolve(cmds.map(() => ({ refused: noPermission() })))
            : transport.pipeline(cmds, timeoutMs),
      }));
      try {
        const { request } = await submittedRequest(refusing.access);
        const unexpected = { code: "store_unexpected" };
        await expect(refusing.access.list("pending", NOW))
          .rejects.toMatchObject(unexpected);
        await expect(refusing.access.decideOn(request.id,
          { to: "approved" }, NOW + 1)).rejects.toMatchObject(unexpected);
      } finally {
        await refusing.close();
      }
    });

  test("a record read that gets no reply is an unexpected reply",
    async () => {
      const short = openTestAccess((transport) => ({
        ...transport,
        pipeline: (cmds, timeoutMs) =>
          cmds.every((cmd) => cmd[0] === "HMGET")
            ? Promise.resolve([])
            : transport.pipeline(cmds, timeoutMs),
      }));
      try {
        await submittedRequest(short.access);
        await expect(short.access.list("pending", NOW))
          .rejects.toMatchObject({ code: "store_unexpected" });
      } finally {
        await short.close();
      }
    });
});
