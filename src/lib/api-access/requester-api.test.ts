import { describe, expect, setSystemTime, test } from "bun:test";
import { z } from "zod";
import { MS_PER_SECOND, SECONDS_PER_DAY } from "@/lib/time-constants";
import {
  TEST_NOW as NOW,
  idForKey,
  issuedKey,
  jsonPost,
  openTestAccess,
  submittedRequest,
  tokenOf,
  useTestAccess,
} from "@/test/api-access-fixtures";
import { realRedisUrl } from "@/test/env";
import { quietConsole } from "@/test/quiet-console";
import { TEST_REQUESTER } from "@/test/access-request-fixtures";
import {
  RedisReplyError,
  RedisUnavailableError,
} from "@/lib/materialize/store";
import type { AccessRequest } from "./access-request";
import { createAccessStore } from "./access-store";
import { createApiAccess } from "./api-access";
import {
  MAX_PENDING,
  MAX_USE_CASE,
  SECRET_CHARS,
  STATUS_TOKEN,
} from "./contract";
import { type Admission, type LinkGate, linkGate } from "./http";
import { createKey, showStatus, submitRequest } from "./requester-api";

quietConsole();

const shownKeySchema = z.object({
  key: z.string(),
  view: z.object({ key: z.object({ last4: z.string() }) }),
});

const form = {
  ...TEST_REQUESTER,
  email: " Ana.Ribeiro@Example.com ",
  ocb_check: "",
};

let hosts = 0;
const nextHost = () => {
  hosts += 1;
  return `2001:db8:${hosts.toString(16)}::1`;
};

const post = (
  body: unknown,
  type = "application/json",
  from = nextHost(),
) => jsonPost(body, { "content-type": type, "x-vercel-forwarded-for": from });

let served = 0;
let admitted = 0;
const openGate: LinkGate = {
  admit: () => {
    admitted += 1;
    return null;
  },
  served: () => {
    served += 1;
  },
  capped: () => {},
  missed: () => {},
};
let held: number[] = [];
const TRAP_FLOOD = 12;
const LINK_REFILL_MS = 6_000;
const FORGED_TOKEN = "A".repeat(SECRET_CHARS);

const storeReplying = (
  reply: (cmd: (string | number)[]) => Promise<unknown>,
) => {
  const pipeline = () => Promise.reject(new Error("unused"));
  const store = createAccessStore("down:", { command: reply, pipeline });
  return showStatus(post({ token: FORGED_TOKEN }), {
    access: createApiAccess(store),
    gate: openGate,
  });
};

test("an unreachable store answers 503, not an unknown link", async () => {
  const res = await storeReplying(() =>
    Promise.reject(new RedisUnavailableError("ECONNRESET")));
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "unavailable" });
});

test("an unexpected or refused store reply is an error, not an outage",
  async () => {
    const replies = [
      () => Promise.resolve(42),
      (cmd: (string | number)[]) =>
        Promise.resolve(cmd[0] === "GET" ? crypto.randomUUID() : 42),
      () => Promise.reject(new RedisReplyError("WRONGTYPE")),
    ];
    for (const reply of replies) {
      await expect(storeReplying(reply))
        .rejects.toMatchObject({ code: "store_unexpected" });
    }
  });

test("a bug under the store is thrown as is, not taken for an outage",
  async () => {
    const bug = new TypeError("reply is not iterable");
    await expect(storeReplying(() => Promise.reject(bug))).rejects.toBe(bug);
  });

describe.skipIf(!realRedisUrl)("requester API on a real Redis", () => {
  const opened = useTestAccess();
  const { access } = opened;
  let announced: AccessRequest[];
  let admissions: number;

  async function submit(
    body: unknown,
    { type = "application/json", to = access, open = true, from = nextHost() } =
      {},
  ) {
    announced = [];
    admissions = 0;
    served = 0;
    held = [];
    return submitRequest(post(body, type, from), {
      access: to,
      now: NOW,
      gate: {
        admit: () => {
          admissions += 1;
          return open ? null : new Response("closed", { status: 429 });
        },
        served: openGate.served,
        capped: (retryAfterSec) => void held.push(retryAfterSec),
      },
      onSubmitted: (r) => void announced.push(r),
      onQueueFull: () => {},
    });
  }

  const submittedToken = async () => tokenOf(await submit(form));
  const statusOf = (body: unknown, from = nextHost()) => {
    served = 0;
    admitted = 0;
    return showStatus(post(body, undefined, from), { access, gate: openGate });
  };
  const keyFor = (body: unknown, now: number) => {
    served = 0;
    admitted = 0;
    return createKey(post(body), { access, gate: openGate, now });
  };

  async function idOf(token: string): Promise<string> {
    const request = await access.byToken(token);
    if (!request) throw new Error("request not stored");
    return request.id;
  }

  test("a request is stored, announced and readable by its link", async () => {
    const res = await submit(form);
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const token = await tokenOf(res);
    expect(announced.map((r) => r.requester.email)).toEqual([
      "ana.ribeiro@example.com",
    ]);

    const status = await statusOf({ token });
    expect(served).toBe(1);
    expect(await status.json()).toEqual({
      status: "pending",
      requestedAt: NOW,
      email: "ana.ribeiro@example.com",
      website: form.website,
    });
  });

  test("invalid fields are named and nothing is stored", async () => {
    const res = await submit({
      ...form,
      website: "javascript:alert(1)",
      useCase: "short",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid",
      fields: ["website", "useCase"],
    });
    expect(announced).toEqual([]);
    const unreadable = await submit("{not json");
    expect(await unreadable.json()).toEqual({ error: "invalid", fields: [] });
    const oversized = await submit({ ...form, name: "x".repeat(9000) });
    expect(await oversized.json()).toEqual({ error: "invalid", fields: [] });
  });

  test("a cross-site plain-text post stores nothing", async () => {
    const res = await submit(form, { type: "text/plain" });
    expect(res.status).toBe(400);
    expect(announced).toEqual([]);
  });

  test("hidden characters in the name, site or use case are refused",
    async () => {
      const res = await submit({
        ...form,
        name: "Ana\u202eRibeiro",
        website: "https://ex\u200bample.com",
        useCase: `${form.useCase}\u200b`,
      });
      expect(await res.json()).toEqual({
        error: "invalid",
        fields: ["name", "website", "useCase"],
      });
      const tabbed = await submit({ ...form, name: "Ana\tRibeiro" });
      expect(await tabbed.json())
        .toEqual({ error: "invalid", fields: ["name"] });
      const blank = await submit({ ...form, name: "   " });
      expect(await blank.json())
        .toEqual({ error: "invalid", fields: ["name"] });
    });

  test("joiners in a name or an emoji are accepted, not in a site",
    async () => {
      const name = "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645";
      const coder = "\u{1f469}\u200d\u{1f4bb}";
      const useCase = `${form.useCase} ${coder}`;
      expect((await submit({ ...form, name, useCase })).status).toBe(201);
      const website = "https://example.com/a\u200db";
      const site = await submit({ ...form, website });
      expect(await site.json())
        .toEqual({ error: "invalid", fields: ["website"] });
    });

  test("admission is asked only for valid requests", async () => {
    expect((await submit({ ...form, useCase: "short" })).status).toBe(400);
    expect(admissions).toBe(0);
    const before = (await access.list("pending", NOW)).counts.pending;
    const res = await submit(form, { open: false });
    expect(await res.text()).toBe("closed");
    expect((await access.list("pending", NOW)).counts.pending).toBe(before);
  });

  test("line breaks count once toward the use case limit", async () => {
    const line = `${"x".repeat(MAX_USE_CASE / 20 - 1)}\r\n`;
    const useCase = line.repeat(20).trim();
    expect(useCase.length).toBeGreaterThan(MAX_USE_CASE);
    expect((await submit({ ...form, useCase })).status).toBe(201);
  });

  test.each([
    ["not_saved", "never reached Redis", true],
    ["unavailable", "may have reached Redis", false],
  ])("a failed save answers %s when it %s", async (error, _, unsent) => {
    const down = () => Promise.reject(new RedisUnavailableError("down",
      { unsent }));
    const failing = openTestAccess((t) =>
      ({ ...t, command: down, pipeline: down }));
    try {
      const res = await submit(form, { to: failing.access });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error });
    } finally {
      await failing.close();
    }
  });

  test("a full queue refuses until a request is decided", async () => {
    const queue = openTestAccess();
    try {
      for (let i = 0; i < MAX_PENDING; i += 1) {
        await submittedRequest(queue.access);
      }
      const from = nextHost();
      const res = await submit(form, { to: queue.access, from });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "queue_full" });
      for (let i = 0; i < 5; i += 1) {
        await submit(form, { to: queue.access, from });
      }
      const [waiting] = (await queue.access.list("pending", NOW)).requests;
      if (!waiting) throw new Error("queue empty");
      const spam = { to: "declined", reason: "Spam." } as const;
      await queue.access.decideOn(waiting.id, spam, NOW);
      const after = await submit(form, { to: queue.access, from });
      expect(after.status).toBe(201);
    } finally {
      await queue.close();
    }
  });

  test("a /48 stores 5 requests an hour; refused tries do not count",
    async () => {
      const from = "2001:db8:aaaa:1::1";
      const neighbour = "2001:db8:aaab:1::1";
      for (let i = 0; i < 5; i += 1) {
        expect((await submit(form, { from, open: false })).status).toBe(429);
      }
      for (let i = 0; i < 5; i += 1) {
        expect((await submit(form, { from: `2001:db8:aaaa:${i + 2}::1` }))
          .status).toBe(201);
      }
      const capped = await submit(form, { from });
      expect(capped.status).toBe(429);
      expect(served).toBe(0);
      const { retryAfterSec } = z.object({ retryAfterSec: z.number() })
        .parse(await capped.json());
      expect(retryAfterSec).toBeGreaterThan(3000);
      expect(held).toEqual([retryAfterSec]);
      expect(announced).toEqual([]);
      expect((await submit(form, { from: neighbour })).status).toBe(201);
      expect(served).toBe(1);
    });

  test("an IPv4 /24 shares one sender cap", async () => {
    for (let i = 1; i <= 5; i += 1) {
      expect((await submit(form, { from: `198.51.100.${i}` })).status)
        .toBe(201);
    }
    expect((await submit(form, { from: "198.51.100.200" })).status).toBe(429);
    expect((await submit(form, { from: "198.51.101.1" })).status).toBe(201);
  });

  test("one link is used at most 10 times a minute, from any network",
    async () => {
      const token = await submittedToken();
      const spent: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        expect((await statusOf({ token })).status).toBe(200);
        spent.push(served);
      }
      expect(spent).toEqual([1, ...Array<number>(9).fill(0)]);
      expect((await statusOf({ token })).status).toBe(429);
      expect({ served, admitted }).toEqual({ served: 0, admitted: 0 });
      expect((await keyFor({ token, replacing: null }, NOW + 1)).status)
        .toBe(429);
      expect({ served, admitted }).toEqual({ served: 0, admitted: 0 });
      expect((await statusOf({ token: await submittedToken() })).status)
        .toBe(200);
      const shared = await submittedToken();
      const reads = await Promise.all(
        Array.from({ length: 12 }, () => statusOf({ token: shared })));
      expect(reads.filter((r) => r.status === 200)).toHaveLength(10);
    });

  test("key attempts on a link use its budget, unknown links do not",
    async () => {
      const token = await submittedToken();
      for (let i = 0; i < 10; i += 1) {
        expect((await keyFor({ token, replacing: null }, NOW + 1)).status)
          .toBe(409);
      }
      expect((await statusOf({ token })).status).toBe(429);
      for (let i = 0; i <= 10; i += 1) {
        const forged = await keyFor(
          { token: FORGED_TOKEN, replacing: null }, NOW + 1);
        expect(forged.status).toBe(404);
      }
    });

  test("a link read all minute long spends the site's budget once",
    async () => {
      const token = await submittedToken();
      const spent: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        setSystemTime(Date.now() + LINK_REFILL_MS);
        expect((await statusOf({ token })).status).toBe(200);
        spent.push(served);
      }
      setSystemTime();
      expect(spent.reduce((sum, n) => sum + n, 0)).toBe(1);
    });

  test("a filled hidden field looks accepted and stores nothing", async () => {
    const before = (await access.list("pending", NOW)).counts.pending;
    const trap = { ...form, ocb_check: "https://spam.example" };
    for (let i = 0; i < TRAP_FLOOD; i += 1) {
      expect((await submit(trap)).status).toBe(201);
    }
    const invalid = { ...trap, useCase: "short" };
    expect((await submit(invalid, { open: false })).status).toBe(201);
    expect(admissions).toBe(0);
    const token = await tokenOf(await submit(trap));
    expect(token).toMatch(STATUS_TOKEN);
    expect(announced).toEqual([]);
    expect((await access.list("pending", NOW)).counts.pending).toBe(before);
    expect((await statusOf({ token })).status).toBe(404);
  });

  test("a key is refused until approval, then shown once", async () => {
    const token = await submittedToken();
    const body = { token, replacing: null };
    const early = await keyFor(body, NOW + 1);
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({ error: "not_approved" });
    expect(served).toBe(0);

    const id = await idOf(token);
    await access.decideOn(id, { to: "approved" }, NOW + 2);
    const res = await keyFor(body, NOW + 3);
    expect(res.status).toBe(201);
    expect(served).toBe(1);
    const shown = shownKeySchema.parse(await res.json());
    expect(await idForKey(access, shown.key)).toBe(id);
    expect(shown.view.key.last4).toBe(shown.key.slice(-4));

    const status = await statusOf({ token });
    expect(JSON.stringify(await status.json())).not.toMatch(/hash|ocb_/i);
    const stale = await keyFor(body, NOW + 4);
    expect(await stale.json()).toEqual({ error: "key_changed" });

    const replacing = shown.view.key.last4;
    const swap = await keyFor({ token, replacing }, NOW + 5);
    expect(swap.status).toBe(201);
    const fresh = shownKeySchema.parse(await swap.json());
    expect(await idForKey(access, fresh.key)).toBe(id);
    expect(await idForKey(access, shown.key)).toBeNull();
  });

  test("a declined requester sees the reason and the deletion date",
    async () => {
      const token = await submittedToken();
      const reason = "The site does not load.";
      await access.decideOn(await idOf(token),
        { to: "declined", reason }, NOW);
      const status = await statusOf({ token });
      expect(await status.json()).toMatchObject({
        status: "declined",
        reason,
        deletedAt: NOW + 30 * SECONDS_PER_DAY * MS_PER_SECOND,
      });
    });

  test("a revoked requester sees which key stopped", async () => {
    const { token, id, key } = await issuedKey(access);
    await access.decideOn(id, { to: "revoked" }, NOW + 5);
    const status = await statusOf({ token });
    expect(await status.json()).toMatchObject({
      status: "revoked",
      lastKey: { last4: key.slice(-4) },
    });
  });

  test("unknown or malformed links get 404", async () => {
    const forged = { token: FORGED_TOKEN, replacing: null };
    expect((await statusOf(forged)).status).toBe(404);
    expect((await keyFor(forged, NOW)).status).toBe(404);
    expect((await statusOf({})).status).toBe(404);
    expect((await keyFor("x", NOW)).status).toBe(404);
  });

  test("a network is refused after 3 unknown links a minute", async () => {
    const admission: Admission = {
      route: `links-${crypto.randomUUID()}`,
      perNetwork: 100,
      perInstance: 100,
    };
    const known = await submittedToken();
    const host = nextHost();
    const status = (token: string, from = host) => {
      const req = post({ token }, undefined, from);
      return showStatus(req, { access, gate: linkGate(req, admission) });
    };
    const key = (token: string) => {
      const req = post({ token, replacing: null }, undefined, host);
      const route = `${admission.route}-key`;
      const gate = linkGate(req, { ...admission, route });
      return createKey(req, { access, gate, now: NOW });
    };
    expect((await status(known)).status).toBe(200);
    expect((await status(FORGED_TOKEN)).status).toBe(404);
    expect((await key(FORGED_TOKEN)).status).toBe(404);
    expect((await status(FORGED_TOKEN)).status).toBe(404);
    expect((await status(known)).status).toBe(429);
    expect((await key(FORGED_TOKEN)).status).toBe(429);
    expect((await status(known, nextHost())).status).toBe(200);
  });
});
