import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { isolateEnv } from "@/test/env";
import { GET as healthCheck } from "./cron/health-check/route";
import { GET as indexNow } from "./cron/indexnow/route";
import { POST as revalidate } from "./internal/revalidate-aggregate/route";

isolateEnv(["CRON_SECRET", "REVALIDATE_TOKEN", "NODE_ENV"]);

const SECRET = "route-secret-value";
const call = (authorization?: string) =>
  new NextRequest("https://example.test/api/x", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });

const routes = [
  ["health-check", "CRON_SECRET", healthCheck, 401],
  ["indexnow", "CRON_SECRET", indexNow, 401],
  ["revalidate-aggregate", "REVALIDATE_TOKEN", revalidate, 503],
] as const;

describe.each(routes)("%s", (_, secretName, handle, closedStatus) => {
  test("refuses a missing or wrong bearer", async () => {
    Object.assign(process.env, { [secretName]: SECRET });
    for (const header of [undefined, "Bearer wrong", SECRET]) {
      expect((await handle(call(header))).status).toBe(401);
    }
  });

  test("stays closed in production without a secret", async () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    const res = await handle(call(`Bearer ${SECRET}`));
    expect(res.status).toBe(closedStatus);
  });
});
