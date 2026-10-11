import { afterEach, describe, expect, test } from "bun:test";
import { redisCommand } from "./cohort-snapshot";

const KEYS = [
  "COHORT_KV_REST_API_URL",
  "COHORT_KV_REST_API_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

function capture(): Array<{ url: string; auth: string | null }> {
  const calls: Array<{ url: string; auth: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return Response.json({ result: "OK" });
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("cohort store credentials", () => {
  test("the COHORT_ pair wins over KV_REST_API_*", async () => {
    for (const k of KEYS) delete process.env[k];
    process.env.COHORT_KV_REST_API_URL = "https://kv.example.com/";
    process.env.COHORT_KV_REST_API_TOKEN = "worker";
    process.env.KV_REST_API_URL = "https://upstash.example.com";
    process.env.KV_REST_API_TOKEN = "upstash";
    const calls = capture();
    await redisCommand(["PING"]);
    expect(calls).toEqual([{ url: "https://kv.example.com", auth: "Bearer worker" }]);
  });

  test("a half-set COHORT_ pair never mixes stores", async () => {
    for (const k of KEYS) delete process.env[k];
    process.env.COHORT_KV_REST_API_URL = "https://kv.example.com";
    process.env.KV_REST_API_URL = "https://upstash.example.com";
    process.env.KV_REST_API_TOKEN = "upstash";
    const calls = capture();
    await redisCommand(["PING"]);
    expect(calls).toEqual([{ url: "https://upstash.example.com", auth: "Bearer upstash" }]);
  });
});
