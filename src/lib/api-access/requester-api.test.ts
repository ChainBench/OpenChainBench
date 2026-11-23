import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  TEST_NOW as NOW,
  jsonPost,
  openTestAccess,
  submittedRequest,
  tokenOf,
  useTestAccess,
} from "@/test/api-access-fixtures";
import { RedisUnavailableError } from "@/lib/materialize/store";
import { realRedisUrl } from "@/test/env";
import { quietConsole } from "@/test/quiet-console";
import { TEST_REQUESTER } from "@/test/access-request-fixtures";
import type { AccessRequest } from "./access-request";
import { MAX_PENDING, MAX_USE_CASE, STATUS_TOKEN } from "./contract";
import type { Gate } from "./http";
import { submitRequest } from "./requester-api";

quietConsole();

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
const countServed: Gate["served"] = () => {
  served += 1;
};
let held: number[] = [];
const TRAP_FLOOD = 12;

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
        served: countServed,
        capped: (retryAfterSec) => void held.push(retryAfterSec),
      },
      onSubmitted: (r) => void announced.push(r),
      onQueueFull: () => {},
    });
  }

  test("a request is stored, announced and found by its link", async () => {
    const res = await submit(form);
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(served).toBe(1);
    const token = await tokenOf(res);
    expect(announced.map((r) => r.requester.email)).toEqual([
      "ana.ribeiro@example.com",
    ]);
    expect((await access.byToken(token))?.requester.email)
      .toBe("ana.ribeiro@example.com");
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
    expect(await access.byToken(token)).toBeNull();
  });
});
