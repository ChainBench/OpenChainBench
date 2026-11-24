import { afterEach, beforeEach } from "bun:test";

export const realRedisUrl = process.env.TEST_REDIS_URL ?? "";

if (process.env.CI && !realRedisUrl) {
  throw new Error("TEST_REDIS_URL must be set in CI");
}

export function isolateEnv(names: readonly string[]): void {
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  beforeEach(() => {
    for (const name of names) delete process.env[name];
  });
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

export const isolateRedisEnv = () =>
  isolateEnv([
    "OCB_REDIS_URL",
    "REDIS_URL",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  ]);
