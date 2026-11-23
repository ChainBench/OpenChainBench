import { mock } from "bun:test";
import * as store from "@/lib/materialize/store";

const entries = new Map<string, { value: string; expiry: number }>();

export const fakeStore = {
  configured: true,
  down: false,
  reset(): void {
    entries.clear();
    fakeStore.configured = true;
    fakeStore.down = false;
  },
};

function live(key: string): string | null {
  const entry = entries.get(key);
  return entry && entry.expiry > Date.now() ? entry.value : null;
}

mock.module("@/lib/materialize/store", () => ({
  ...store,
  storeConfigured: () => fakeStore.configured,
  redisCommand: async ([verb, key, value, condition, unit, ttl]: (
    string | number
  )[]) => {
    if (fakeStore.down) throw new Error("connection refused");
    const name = String(key);
    if (verb === "GETDEL") {
      const stored = live(name);
      entries.delete(name);
      return stored;
    }
    if (verb !== "SET" || condition !== "NX" || unit !== "PX") {
      throw new Error(`unsupported command ${verb}`);
    }
    if (live(name) !== null) return null;
    entries.set(name, {
      value: String(value),
      expiry: Date.now() + Number(ttl),
    });
    return "OK";
  },
}));
