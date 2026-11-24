import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  TEST_NOW,
  issuedKey,
  openTestAccess,
  useTestAccess,
} from "@/test/api-access-fixtures";
import { deferredWork } from "@/test/deferred-work";
import { isolateEnv, isolateRedisEnv, realRedisUrl } from "@/test/env";
import { quietConsole } from "@/test/quiet-console";
import { sha256Hex } from "@/lib/sha256";
import { MS_PER_MINUTE, MS_PER_SECOND } from "@/lib/time-constants";
import { AccessStoreError } from "./access-store";
import { namespaceFor } from "./api-access";
import { createCallerLimit, limitApiCall } from "./caller";
import {
  KEYED_PER_MINUTE,
  KEY_CACHE_SECONDS,
  NEW_KEY_DELAY_SECONDS,
  OUTAGE_KEY_GRACE_MINUTES,
  SECRET_CHARS,
} from "./contract";
import {
  PUBLIC_PER_MINUTE,
  type PublicRoute,
  keyedPerMinute,
} from "./public-limits";

quietConsole();

const INDEX_TTL_MS = KEY_CACHE_SECONDS * MS_PER_SECOND;
const MISS_RELOAD_MS = NEW_KEY_DELAY_SECONDS * MS_PER_SECOND;
const LAST_KNOWN_MAX_MS = OUTAGE_KEY_GRACE_MINUTES * MS_PER_MINUTE;
const WITHIN_PAUSE_MS = 5_000;
const CAPACITIES = { stat: 2, compare: 2 } as const;
type Route = keyof typeof CAPACITIES;
const KEYED: Record<Route, number> = { stat: KEYED_PER_MINUTE, compare: 3 };
const keyedCapacity = (route: Route) => KEYED[route];

let ip = 0;
function caller(header?: string) {
  ip += 1;
  const address = `198.51.100.${ip}`;
  return (from = address) => {
    const headers = new Headers({ "x-vercel-forwarded-for": from });
    if (header !== undefined) headers.set("authorization", header);
    return new Request("http://localhost/api/stat/ethereum-rpc", { headers });
  };
}

const randomKey = () =>
  `ocb_${crypto.randomUUID().replace(/-/g, "").padEnd(SECRET_CHARS, "x")}`;

function keyStore(...keys: string[]) {
  const ids = new Map(keys.map((k) => [sha256Hex(k), crypto.randomUUID()]));
  let loads = 0;
  return {
    ids,
    loads: () => loads,
    load: async (): Promise<ReadonlyMap<string, string>> => {
      loads += 1;
      return new Map(ids);
    },
  };
}

const unavailable = () =>
  new AccessStoreError("store_unavailable", "unreachable");
const unexpectedReply = () =>
  new AccessStoreError("store_unexpected", "unexpected Redis reply");

const runNow = (work: () => Promise<void>) => void work();

function flakyIndex(...keys: string[]) {
  const store = keyStore(...keys);
  const state = { clock: TEST_NOW, down: false, hung: false, loadMs: 0 };
  const { defer, flush } = deferredWork();
  const limit = createCallerLimit({
    load: async () => {
      if (state.down) throw unavailable();
      if (state.hung) return new Promise<never>(() => {});
      state.clock += state.loadMs;
      return store.load();
    },
    now: () => state.clock,
    defer,
    capacities: CAPACITIES,
    keyedCapacity,
  });
  return { limit, state, store, flush };
}

const callerLimit = (
  load: () => Promise<ReadonlyMap<string, string>>,
  now = () => TEST_NOW,
) =>
  createCallerLimit({
    load,
    now,
    defer: runNow,
    capacities: CAPACITIES,
    keyedCapacity,
  });

type Limit = ReturnType<typeof callerLimit>;

async function statuses(
  limit: Limit,
  request: () => Request,
  calls: number,
  route: Route = "stat",
) {
  const out: number[] = [];
  for (let i = 0; i < calls; i += 1) {
    const refused = await limit(request(), route);
    out.push(refused?.status ?? 200);
  }
  return out;
}

describe("API calls checked against the key index", () => {
  test("other schemes and bearers keep the public limit", async () => {
    const limit = callerLimit(keyStore().load);
    const headers = [
      undefined,
      "Basic dXNlcjpwYXNz",
      "Bearer",
      "Bearer partner-internal-token",
      "Bearer eyJhbGciOiJIUzI1NiJ9.ocb_x.sig",
    ];
    for (const header of headers) {
      expect(await statuses(limit, caller(header), 3))
        .toEqual([200, 200, 429]);
    }
    const anonymous = caller();
    await statuses(limit, anonymous, 2);
    const capped = await limit(anonymous(), "stat");
    expect(await capped?.json()).toMatchObject({
      message: expect.stringContaining("/api-access"),
    });
  });

  test("AI crawlers skip the limits, with or without a key", async () => {
    const key = randomKey();
    const limit = callerLimit(keyStore(key).load);
    const crawler = (authorization?: string) => () =>
      new Request("http://localhost/api/stat/ethereum-rpc", {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2)",
          ...(authorization ? { authorization } : {}),
        },
      });
    expect(await statuses(limit, crawler(), 5)).not.toContain(429);
    expect(await statuses(limit, crawler(`Bearer ${key}`),
      KEYED_PER_MINUTE + 1)).not.toContain(429);
  });

  test("a key outside the Bearer form, or unknown, gets 401", async () => {
    const store = keyStore();
    const limit = callerLimit(store.load);
    const cases = [
      ["Bearer ocb_", "invalid_api_key"],
      [`Token ${randomKey()}`, "malformed_authorization"],
      [randomKey(), "malformed_authorization"],
      [`bearer ${randomKey()}`, "invalid_api_key"],
    ] as const;
    for (const [header, error] of cases) {
      const refused = await limit(caller(header)(), "stat");
      expect(refused?.status).toBe(401);
      expect(refused?.headers.get("WWW-Authenticate")).toContain("Bearer");
      expect(await refused?.json()).toMatchObject({ error });
    }
    expect(store.loads()).toBe(1);
  });

  test("repeating a refused key is capped per network", async () => {
    const limit = callerLimit(keyStore().load);
    const send = caller(`Bearer ${randomKey()}`);
    let host = 0;
    const request = () => {
      host += 1;
      return send(`2001:dba:77:1::${host.toString(16)}`);
    };
    const calls = await statuses(limit, request, 40);
    expect(calls.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(calls.slice(30)).toContain(429);
    const capped = await limit(request(), "stat");
    expect(capped?.status).toBe(429);
    const otherNetwork = await limit(send("2001:dba:77:2::1"), "stat");
    expect(otherNetwork?.status).toBe(401);
    expect(capped?.headers.get("Retry-After")).not.toBeNull();
    expect(await capped?.json())
      .toMatchObject({ error: "invalid_api_key_limited" });
    const malformed = caller(`Token ${randomKey()}`)("2001:dba:77:1::ff");
    expect(await (await limit(malformed, "stat"))?.json())
      .toMatchObject({ error: "malformed_authorization_limited" });
  });

  test("a crawler sending refused keys is capped too", async () => {
    const limit = callerLimit(keyStore().load);
    const request = () =>
      new Request("http://localhost/api/stat/ethereum-rpc", {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)",
          "x-vercel-forwarded-for": "2001:dba:79::1",
          authorization: `Bearer ${randomKey()}`,
        },
      });
    const calls = await statuses(limit, request, 31);
    expect(calls.at(-1)).toBe(429);
  });

  test("a malformed key during an outage gets 401 without a load",
    async () => {
      let attempts = 0;
      const limit = callerLimit(async () => {
        attempts += 1;
        throw unavailable();
      });
      const refused = await limit(caller("Bearer ocb_abc")(), "stat");
      expect(refused?.status).toBe(401);
      expect(attempts).toBe(0);
    });

  test("made-up keys reload the index at most once per 5 s", async () => {
    let clock = TEST_NOW;
    const store = keyStore();
    const limit = callerLimit(store.load, () => clock);
    for (let i = 1; i <= 100; i += 1) {
      const request = caller(`Bearer ${randomKey()}`)(`2001:db8:${i}::1`);
      expect((await limit(request, "stat"))?.status).toBe(401);
    }
    expect(store.loads()).toBe(1);
    clock += MISS_RELOAD_MS;
    for (let i = 1; i <= 100; i += 1) {
      await limit(caller(`Bearer ${randomKey()}`)(`2001:db9:${i}::1`), "stat");
    }
    expect(store.loads()).toBe(2);
  });

  test("calls at once share a single load", async () => {
    const key = randomKey();
    const store = keyStore(key);
    const { promise: answered, resolve: answer } =
      Promise.withResolvers<void>();
    const limit = callerLimit(async () => {
      await answered;
      return store.load();
    });
    const request = caller(`Bearer ${key}`);
    const calls = Promise.all(
      Array.from({ length: 50 }, () => limit(request(), "stat")),
    );
    answer();
    expect((await calls).every((r) => r === null)).toBe(true);
    expect(store.loads()).toBe(1);
  });

  test("a key created after the load works 5 s later", async () => {
    let clock = TEST_NOW;
    const store = keyStore();
    const limit = callerLimit(store.load, () => clock);
    await limit(caller(`Bearer ${randomKey()}`)(), "stat");
    const key = randomKey();
    store.ids.set(sha256Hex(key), crypto.randomUUID());
    const request = caller(`Bearer ${key}`);
    expect((await limit(request(), "stat"))?.status).toBe(401);
    clock += MISS_RELOAD_MS;
    expect(await limit(request(), "stat")).toBeNull();
  });

  test("index age counts from when the load started", async () => {
    const key = randomKey();
    const { limit, state, store } = flakyIndex(key);
    state.loadMs = 2000;
    const request = caller(`Bearer ${key}`);
    expect(await limit(request(), "stat")).toBeNull();
    store.ids.delete(sha256Hex(key));
    expect(await limit(request(), "stat")).toBeNull();
    state.clock = TEST_NOW + INDEX_TTL_MS;
    expect((await limit(request(), "stat"))?.status).toBe(401);
  });

  test.each([
    ["an outage", unavailable],
    ["an unexpected reply", unexpectedReply],
  ])("with no index yet, %s counts keys at the public limit",
    async (_, failure) => {
      let loads = 0;
      const limit = callerLimit(async () => {
        loads += 1;
        throw failure();
      });
      const request = caller(`Bearer ${randomKey()}`);
      expect(await statuses(limit, request, 2)).toEqual([200, 200]);
      const refused = await limit(request(), "stat");
      expect(refused?.status).toBe(429);
      expect(refused?.headers.get("X-OCB-Key")).toBe("unverified");
      expect(refused?.headers.get("Cache-Control")).toBe("no-store");
      expect(await refused?.json()).toMatchObject({ keyUnverified: true });
      expect(loads).toBe(1);
    });

  test("during an outage, keys from the last index keep their limit",
    async () => {
      const key = randomKey();
      const { limit, state } = flakyIndex(key);
      const known = caller(`Bearer ${key}`);
      expect(await limit(known(), "stat")).toBeNull();
      state.down = true;
      state.clock += INDEX_TTL_MS;
      expect(await statuses(limit, known, 5)).toEqual([200, 200, 200, 200,
        200]);
      const other = caller(`Bearer ${randomKey()}`);
      expect(await statuses(limit, other, 2)).toEqual([200, 200]);
      const refused = await limit(other(), "stat");
      expect(refused?.status).toBe(429);
      expect(refused?.headers.get("X-OCB-Key")).toBe("unverified");
    });

  test("a long outage stops trusting the last index", async () => {
    const key = randomKey();
    const { limit, state } = flakyIndex(key);
    const known = caller(`Bearer ${key}`);
    expect(await limit(known(), "stat")).toBeNull();
    state.down = true;
    state.clock += LAST_KNOWN_MAX_MS - MS_PER_SECOND;
    expect(await statuses(limit, known, 3)).toEqual([200, 200, 200]);
    state.clock += MS_PER_SECOND;
    expect(await statuses(limit, known, 3)).toEqual([200, 200, 429]);
  });

  test("an unknown key during an outage counts at the public limit",
    async () => {
      const { limit, state, store } = flakyIndex();
      await limit(caller(`Bearer ${randomKey()}`)(), "stat");
      expect(store.loads()).toBe(1);
      state.down = true;
      state.clock += MISS_RELOAD_MS;
      const request = caller(`Bearer ${randomKey()}`);
      expect(await statuses(limit, request, 2)).toEqual([200, 200]);
      const refused = await limit(request(), "stat");
      expect(refused?.status).toBe(429);
      expect(refused?.headers.get("X-OCB-Key")).toBe("unverified");
    });

  test("loads pause after an outage, then resume", async () => {
    let clock = TEST_NOW;
    const key = randomKey();
    const store = keyStore(key);
    let attempts = 0;
    const limit = callerLimit(async () => {
      attempts += 1;
      if (attempts === 1) throw unavailable();
      return store.load();
    }, () => clock);
    const request = caller(`Bearer ${key}`);
    await limit(request(), "stat");
    clock += WITHIN_PAUSE_MS;
    await limit(caller(`Bearer ${key}`)(), "stat");
    expect(attempts).toBe(1);
    clock += MS_PER_MINUTE;
    expect(await statuses(limit, request, 4)).toEqual([200, 200, 200, 200]);
    expect(store.loads()).toBe(1);
  });

  test("after an outage, calls answer from the last index while it reloads",
    async () => {
      const key = randomKey();
      const { limit, state } = flakyIndex(key);
      const known = caller(`Bearer ${key}`);
      expect(await limit(known(), "stat")).toBeNull();
      state.down = true;
      state.clock += INDEX_TTL_MS;
      expect(await limit(known(), "stat")).toBeNull();
      state.down = false;
      state.hung = true;
      state.clock += MS_PER_MINUTE;
      expect(await statuses(limit, known, 3)).toEqual([200, 200, 200]);
    });

  test("after an outage, the reload outlives the call that started it",
    async () => {
      const key = randomKey();
      const { limit, state, store, flush } = flakyIndex(key);
      const known = caller(`Bearer ${key}`);
      await limit(known(), "stat");
      state.down = true;
      state.clock += INDEX_TTL_MS;
      await limit(known(), "stat");
      state.down = false;
      state.clock += MS_PER_MINUTE;
      await limit(known(), "stat");
      expect(store.loads()).toBe(1);
      await flush();
      expect(store.loads()).toBe(2);
    });

  test("after an outage, unknown keys do not wait for the reload",
    async () => {
      const { limit, state } = flakyIndex();
      await limit(caller(`Bearer ${randomKey()}`)(), "stat");
      state.down = true;
      state.clock += MISS_RELOAD_MS;
      await limit(caller(`Bearer ${randomKey()}`)(), "stat");
      state.down = false;
      state.hung = true;
      state.clock += INDEX_TTL_MS / 2;
      const unknown = caller(`Bearer ${randomKey()}`);
      expect(await statuses(limit, unknown, 3)).toEqual([200, 200, 429]);
    });

  test("once the store is back, a revoked key is refused again",
    async () => {
      const key = randomKey();
      const { limit, state, store, flush } = flakyIndex(key);
      const known = caller(`Bearer ${key}`);
      expect(await limit(known(), "stat")).toBeNull();
      state.down = true;
      state.clock += INDEX_TTL_MS;
      expect(await limit(known(), "stat")).toBeNull();
      state.down = false;
      state.clock += INDEX_TTL_MS;
      expect(await limit(known(), "stat")).toBeNull();
      await flush();
      store.ids.delete(sha256Hex(key));
      state.clock += INDEX_TTL_MS;
      expect((await limit(known(), "stat"))?.status).toBe(401);
    });

  test("a bug in the load is not taken for an outage", async () => {
    const limit = callerLimit(async () => {
      throw new TypeError("load bug");
    });
    const request = caller(`Bearer ${randomKey()}`);
    await expect(limit(request(), "stat")).rejects.toThrow(TypeError);
  });

  test("a key's limit follows the route", async () => {
    const key = randomKey();
    const limit = callerLimit(keyStore(key).load);
    const request = caller(`Bearer ${key}`);
    expect(await statuses(limit, request, 4, "compare"))
      .toEqual([200, 200, 200, 429]);
    expect(await (await limit(request(), "compare"))?.json()).toMatchObject({
      message: expect.stringContaining("its 3 requests per minute"),
    });
    const anonymous = caller();
    await statuses(limit, anonymous, 2, "compare");
    expect(await (await limit(anonymous(), "compare"))?.json()).toMatchObject({
      message: expect.stringContaining("for 3 requests per minute"),
    });
  });
});

describe.skipIf(!realRedisUrl)("API calls with a key on a real Redis", () => {
  const { access } = useTestAccess();
  let clock = TEST_NOW;
  const limit = callerLimit(() => access.keyIndex(), () => clock);

  test("a key gets its own limit per route, from any IP", async () => {
    const { key } = await issuedKey(access);
    clock += MISS_RELOAD_MS;
    const request = caller(`bearer ${key}`);
    const calls = await statuses(limit, request, KEYED_PER_MINUTE + 30);
    expect(calls.slice(0, KEYED_PER_MINUTE).every((s) => s === 200))
      .toBe(true);
    expect(calls.slice(KEYED_PER_MINUTE)).toContain(429);
    expect((await limit(request("192.0.2.200"), "stat"))?.status)
      .toBe(429);
    expect(await limit(request(), "compare")).toBeNull();
  });

  test("a revoked key gets 401 once the index expires", async () => {
    const { key, id } = await issuedKey(access);
    clock += MISS_RELOAD_MS;
    const request = caller(`Bearer ${key}`);
    expect(await limit(request(), "stat")).toBeNull();
    await access.decideOn(id, { to: "revoked" }, TEST_NOW);
    clock += INDEX_TTL_MS;
    const refused = await limit(request(), "stat");
    expect(refused?.status).toBe(401);
    expect(refused?.headers.get("Cache-Control")).toBe("no-store");
  });
});

async function keyedCallsUntilRefused(key: string, route: PublicRoute) {
  const request = caller(`Bearer ${key}`);
  for (let calls = 0; calls <= KEYED_PER_MINUTE; calls += 1) {
    if (await limitApiCall(request(), route)) return calls;
  }
  return Number.POSITIVE_INFINITY;
}

describe.skipIf(!realRedisUrl)("the site's API limiter on a real Redis", () => {
  isolateRedisEnv();
  isolateEnv(["VERCEL_ENV"]);

  test("a stored key lifts the public limit, less on costly routes",
    async () => {
      process.env.OCB_REDIS_URL = realRedisUrl;
      process.env.VERCEL_ENV = `test-${randomUUID()}`;
      const opened = openTestAccess((t) => t, namespaceFor(process.env));
      try {
        const { key } = await issuedKey(opened.access);
        const from = "192.0.2.251";
        for (let i = 0; i <= PUBLIC_PER_MINUTE.stat; i += 1) {
          await limitApiCall(caller()(from), "stat");
        }
        expect((await limitApiCall(caller()(from), "stat"))?.status)
          .toBe(429);
        expect(await limitApiCall(caller(`Bearer ${key}`)(from), "stat"))
          .toBeNull();
        for (const costly of ["og", "llm-context"] as const) {
          const allowed = await keyedCallsUntilRefused(key, costly);
          expect(allowed).toBeLessThan(KEYED_PER_MINUTE);
          expect(allowed).toBe(keyedPerMinute(costly));
        }
      } finally {
        await opened.close();
      }
    });
});
