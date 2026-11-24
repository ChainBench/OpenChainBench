import { afterEach, describe, expect, test } from "bun:test";
import {
  TEST_NOW,
  jsonPost,
  openTestAccess,
  submittedRequest,
} from "@/test/api-access-fixtures";
import { deferredWork } from "@/test/deferred-work";
import { realRedisUrl } from "@/test/env";
import { teamRecorder } from "@/test/team-recorder";
import { TEST_REQUESTER } from "@/test/access-request-fixtures";
import { quietConsole } from "@/test/quiet-console";
import { MAX_PENDING } from "./contract";
import { createRequestRoute } from "./request-route";
import { newRequestMessage, queueFullMessage } from "./team-message";

quietConsole();

const form = { ...TEST_REQUESTER, ocb_check: "" };
let opened: ReturnType<typeof openTestAccess>[] = [];

function routeOnOwnQueue() {
  const queue = openTestAccess();
  opened.push(queue);
  const { sent, notify } = teamRecorder();
  const { defer, flush } = deferredWork();
  const submit = createRequestRoute({
    access: () => queue.access,
    now: () => TEST_NOW,
    defer,
    notify,
  });
  const post = async (network: string) => {
    const res = await submit(
      jsonPost(form, { "x-vercel-forwarded-for": `${network}::1` }));
    await flush();
    return res.status;
  };
  return { access: queue.access, sent, post };
}

describe.skipIf(!realRedisUrl)("request route", () => {
  afterEach(async () => {
    await Promise.all(opened.map((queue) => queue.close()));
    opened = [];
  });

  test("a stored request is posted to the team", async () => {
    const route = routeOnOwnQueue();
    expect(await route.post("2001:db8:e1")).toBe(201);
    expect(route.sent).toEqual([newRequestMessage(TEST_REQUESTER)]);
  });

  test("a full queue alerts the team instead", async () => {
    const route = routeOnOwnQueue();
    for (let i = 0; i < MAX_PENDING; i += 1) {
      await submittedRequest(route.access);
    }
    expect(await route.post("2001:db8:e2")).toBe(503);
    expect(route.sent).toEqual([queueFullMessage()]);
  });
});
