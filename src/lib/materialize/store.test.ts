import { afterEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { isolateRedisEnv, realRedisUrl } from "@/test/env";
import {
  RedisReplyError,
  RedisUnavailableError,
  heartbeat,
  redisPipeline,
  redisPipelineSettled,
  tcpTransport,
} from "./store";

isolateRedisEnv();

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function upstashAnswering(answer: () => Response) {
  process.env.KV_REST_API_URL = "https://upstash.example.com";
  process.env.KV_REST_API_TOKEN = "token";
  globalThis.fetch = Object.assign(async () => answer(), {
    preconnect: realFetch.preconnect,
  });
}

const failureOf = (work: Promise<unknown>) => work.then(() => null, (e) => e);

describe("replies over REST", () => {
  const refusedBy = (error: string, status = 200) => ({
    single: () => Response.json({ error }, { status }),
    batch: () =>
      status === 200
        ? Response.json([{ error }])
        : Response.json({ error }, { status }),
  });
  const failing = (status: number) => ({
    single: () => new Response("down", { status }),
    batch: () => new Response("down", { status }),
  });

  const answering = (body: unknown) => ({
    single: () => Response.json(body),
    batch: () => Response.json([body]),
  });
  const refused = RedisReplyError;
  const down = RedisUnavailableError;

  test.each([
    ["a command on the wrong type", refusedBy("WRONGTYPE"), refused],
    ["a refused command", refusedBy("ERR syntax", 400), refused],
    ["a full store", refusedBy("OOM command not allowed"), down],
    ["a loading store", refusedBy("LOADING Redis is loading"), down],
    ["a replica", refusedBy("READONLY You can't write"), down],
    ["a busy script", refusedBy("BUSY Redis is busy"), down],
    ["a lost master", refusedBy("MASTERDOWN Link is down"), down],
    ["a quota", refusedBy("ERR max requests limit exceeded", 400), down],
    ["an answer of the wrong shape", answering(null), down],
    ["an answer with neither result nor error", answering({}), down],
    ["an answer with unknown fields", answering({ foo: 1 }), down],
    ["an answer that is not JSON", {
      single: () => new Response("<html>"),
      batch: () => new Response("<html>"),
    }, down],
    ["a failing service", failing(503), down],
    ["a bad token", failing(401), down],
  ])("%s", async (_, answers, expected) => {
    upstashAnswering(answers.single);
    const single = await failureOf(heartbeat());
    upstashAnswering(answers.batch);
    const batch = await failureOf(redisPipeline([["GET", "k"]]));
    for (const failure of [single, batch]) {
      expect(failure).toBeInstanceOf(expected);
    }
  });

  test("an unreachable service is an outage", async () => {
    upstashAnswering(() => {
      throw new TypeError("fetch failed");
    });
    expect(await failureOf(heartbeat())).toBeInstanceOf(down);
  });

  test("a reply cut off while its body is read is an outage", async () => {
    upstashAnswering(() =>
      new Response(new ReadableStream({
        start(body) {
          body.enqueue(new TextEncoder().encode('{"resu'));
          body.error(new DOMException("timed out", "TimeoutError"));
        },
      })));
    expect(await failureOf(heartbeat())).toBeInstanceOf(down);
  });

  test("a settled pipeline throws an entry that means an outage", async () => {
    upstashAnswering(() =>
      Response.json([{ result: "1" }, { error: "OOM command not allowed" }]));
    const pair = redisPipelineSettled([["GET", "a"], ["GET", "b"]]);
    expect(await failureOf(pair)).toBeInstanceOf(down);
  });

  test("a pipeline answered with fewer replies is an outage", async () => {
    upstashAnswering(() => Response.json([{ result: "1" }]));
    const pair = redisPipeline([["GET", "a"], ["GET", "b"]]);
    expect(await failureOf(pair)).toBeInstanceOf(down);
  });

  test("a settled pipeline keeps the entries around a refusal", async () => {
    upstashAnswering(() =>
      Response.json([{ result: "1" }, { error: "WRONGTYPE" }]));
    const replies = await redisPipelineSettled([["GET", "a"], ["GET", "b"]]);
    expect(replies[0]).toEqual({ result: "1" });
    expect(replies[1]).toMatchObject({ refused: expect.any(RedisReplyError) });
  });
});

describe.skipIf(!realRedisUrl)("replies over TCP", () => {
  const replying = (error: string) =>
    ["EVAL", `return redis.error_reply("${error}")`, 0];

  test.each([
    ["a refused command", "ERR syntax", RedisReplyError],
    ["a full store", "OOM command not allowed", RedisUnavailableError],
    ["a loading store", "LOADING Redis is loading", RedisUnavailableError],
    ["a replica", "READONLY You can't write", RedisUnavailableError],
    ["a busy script", "BUSY Redis is busy", RedisUnavailableError],
    ["a lost master", "MASTERDOWN Link is down", RedisUnavailableError],
  ])("%s", async (_, error, expected) => {
    process.env.OCB_REDIS_URL = realRedisUrl;
    const failure = await failureOf(redisPipeline([replying(error)]));
    expect(failure).toBeInstanceOf(expected);
  });

  test("a settled pipeline keeps the entries around a refusal", async () => {
    process.env.OCB_REDIS_URL = realRedisUrl;
    const key = `test:${crypto.randomUUID()}`;
    try {
      await redisPipeline([["HSET", key, "f", "v"]]);
      const replies = await redisPipelineSettled([["GET", key], ["PING"]]);
      expect(replies[0]).toMatchObject({
        refused: expect.any(RedisReplyError),
      });
      expect(replies[1]).toEqual({ result: "PONG" });
    } finally {
      await redisPipeline([["DEL", key]]);
    }
  });

  test("a command that outlives its timeout is an outage", async () => {
    const client = new Redis(realRedisUrl);
    const blocking = ["BLPOP", `test:${crypto.randomUUID()}`, 1];
    try {
      const single = tcpTransport(client).command(blocking, 20);
      expect(await failureOf(single)).toBeInstanceOf(RedisUnavailableError);
      const listed = tcpTransport(client).pipeline([["PING"], blocking], 20);
      expect(await failureOf(listed)).toBeInstanceOf(RedisUnavailableError);
    } finally {
      client.disconnect();
    }
  });

  test("a connection that cannot send is an outage", async () => {
    const client = new Redis(realRedisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    client.disconnect();
    const failure = await failureOf(tcpTransport(client).command(["PING"], 1000));
    expect(failure).toBeInstanceOf(RedisUnavailableError);
    expect(failure.message).toContain(failure.cause.message);
  });
});
