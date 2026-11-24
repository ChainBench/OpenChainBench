import { randomUUID } from "node:crypto";
import { afterAll } from "bun:test";
import Redis from "ioredis";
import type { AccessRequest } from "@/lib/api-access/access-request";
import { createAccessStore } from "@/lib/api-access/access-store";
import { type ApiAccess, createApiAccess } from "@/lib/api-access/api-access";
import { tokenBodySchema } from "@/lib/api-access/contract";
import { type RedisTransport, tcpTransport } from "@/lib/materialize/store";
import { sha256Hex } from "@/lib/sha256";
import { TEST_REQUESTER } from "./access-request-fixtures";
import { realRedisUrl } from "./env";

function openRealRedis(namespace: string) {
  const client = new Redis(realRedisUrl, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  const transport = tcpTransport(client);
  const close = async () => {
    const keys = await client.keys(`${namespace}*`);
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  };
  const keysEndingWith = (suffix: string) =>
    client.keys(`${namespace}*:${suffix}`);
  const recordKey = async (id: string) => {
    const [key, ...others] = await keysEndingWith(id);
    if (!key || others.length > 0) throw new Error(`no single record ${id}`);
    return key;
  };
  const corruptRecord = async (id: string) => {
    await client.hset(await recordKey(id), "doc", "{}");
  };
  const retypeRecord = async (id: string) => {
    const key = await recordKey(id);
    await client.del(key);
    await client.set(key, "{}");
  };
  const tokenStored = async (token: string) =>
    (await keysEndingWith(sha256Hex(token))).length === 1;
  const keysOf = async (id: string, token: string) => [
    await recordKey(id),
    ...(await keysEndingWith(sha256Hex(token))),
  ];
  const secondsLeft = async (id: string, token: string) =>
    Promise.all((await keysOf(id, token)).map((key) => client.ttl(key)));
  const expire = async (id: string, token: string) => {
    await client.del(...(await keysOf(id, token)));
  };
  const expireIn = async (id: string, seconds: number) => {
    await client.expire(await recordKey(id), seconds);
  };
  const valuesOf = async (key: string): Promise<string[]> => {
    const type = await client.type(key);
    if (type === "hash") return Object.values(await client.hgetall(key));
    if (type === "zset") return client.zrange(key, 0, -1);
    if (type === "string") return [(await client.get(key)) ?? ""];
    return [];
  };
  const expireSenderInMs = async (senderHash: string, ms: number) => {
    await client.pexpire(`${namespace}sender:${senderHash}`, ms);
  };
  const storedText = async () => {
    const keys = await client.keys(`${namespace}*`);
    const values = await Promise.all(keys.map(valuesOf));
    return [...keys, ...values.flat()].join("\n");
  };
  return {
    transport,
    corruptRecord,
    retypeRecord,
    tokenStored,
    storedText,
    secondsLeft,
    expire,
    expireIn,
    expireSenderInMs,
    close,
  };
}

export const jsonPost = (
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

export const TEST_NOW = Date.UTC(2026, 10, 22, 14, 2);

type Wrap = (transport: RedisTransport) => RedisTransport;

export function openTestAccess(
  wrap: Wrap = (t) => t,
  namespace = `test:${randomUUID()}:`,
) {
  const { transport, ...helpers } = openRealRedis(namespace);
  const store = createAccessStore(namespace, wrap(transport));
  return { access: createApiAccess(store), store, ...helpers };
}

export function useTestAccess() {
  const opened = openTestAccess();
  afterAll(() => opened.close());
  return opened;
}

export async function submittedRequest(
  access: ApiAccess,
): Promise<{ token: string; request: AccessRequest }> {
  const submitted = await access.submit(TEST_REQUESTER,
    { now: TEST_NOW, sender: randomUUID() });
  if (!submitted.ok) throw new Error(submitted.error);
  return { token: submitted.token, request: submitted.request };
}

export async function approvedRequest(
  access: ApiAccess,
): Promise<{ token: string; id: string }> {
  const { token, request } = await submittedRequest(access);
  await access.decideOn(request.id, { to: "approved" }, TEST_NOW + 1);
  return { token, id: request.id };
}

export async function issuedKey(
  access: ApiAccess,
): Promise<{ token: string; id: string; key: string }> {
  const { token, id } = await approvedRequest(access);
  const issued = await access.issueKey(
    { token, replacing: null, now: TEST_NOW + 2 });
  if (!issued.ok) throw new Error(issued.error);
  return { token, id, key: issued.key };
}

export async function idForKey(
  access: ApiAccess,
  key: string,
): Promise<string | null> {
  return (await access.keyIndex()).get(sha256Hex(key)) ?? null;
}

export async function tokenOf(res: Response): Promise<string> {
  return tokenBodySchema.parse(await res.json()).token;
}
