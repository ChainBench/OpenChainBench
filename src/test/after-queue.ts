import { mock } from "bun:test";
import * as nextServer from "next/server";

const pending: Promise<unknown>[] = [];

mock.module("next/server", () => ({
  ...nextServer,
  after: (task: () => Promise<unknown>) => {
    pending.push(task());
  },
}));

export async function settleAfter(): Promise<void> {
  await Promise.all(pending.splice(0));
}
