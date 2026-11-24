import { describe, expect, test } from "bun:test";
import { PENDING_REQUEST } from "@/test/access-request-fixtures";
import { deferredWork } from "@/test/deferred-work";
import { quietConsole } from "@/test/quiet-console";
import { teamRecorder } from "@/test/team-recorder";
import type { TeamDelivery } from "@/lib/team-notify";
import { MS_PER_HOUR, MS_PER_MINUTE } from "@/lib/time-constants";
import { createQueueFullAlert, createRequestAnnouncer } from "./team-alerts";
import {
  moreRequestsMessage,
  newRequestMessage,
  queueFullMessage,
} from "./team-message";

quietConsole();

function teamChannel(answers: TeamDelivery[]) {
  let clock = 0;
  return {
    ...teamRecorder(answers),
    ...deferredWork(),
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function alertWith(answers: TeamDelivery[]) {
  const team = teamChannel(answers);
  const alert = createQueueFullAlert({
    ...team,
    send: () => team.notify(queueFullMessage()),
  });
  return {
    ...team,
    alert: async () => {
      alert();
      await team.flush();
    },
  };
}

describe("queue full alert", () => {
  test("tells the team once an hour", async () => {
    const t = alertWith([]);
    await t.alert();
    await t.alert();
    expect(t.sent.length).toBe(1);
    t.advance(MS_PER_HOUR - 1);
    await t.alert();
    expect(t.sent.length).toBe(1);
    t.advance(1);
    await t.alert();
    expect(t.sent.length).toBe(2);
  });

  test("a failed delivery is retried at once", async () => {
    const t = alertWith(["failed"]);
    await t.alert();
    expect(t.sent.length).toBe(2);
    t.advance(MS_PER_MINUTE);
    await t.alert();
    expect(t.sent.length).toBe(2);
  });

  test.each(["unsure", "refused"] as const)(
    "a delivery %s is not sent twice", async (delivery) => {
      const t = alertWith([delivery]);
      await t.alert();
      expect(t.sent.length).toBe(1);
    });

  test("a delivery failed twice is tried again a minute later", async () => {
    const t = alertWith(["failed", "failed"]);
    await t.alert();
    t.advance(MS_PER_MINUTE - 1);
    await t.alert();
    expect(t.sent.length).toBe(2);
    t.advance(1);
    await t.alert();
    expect(t.sent.length).toBe(3);
  });

  test("with no team channel, it tries once an hour", async () => {
    const t = alertWith(["unconfigured"]);
    await t.alert();
    t.advance(MS_PER_MINUTE);
    await t.alert();
    expect(t.sent.length).toBe(1);
  });
});

function announcerWith(answers: TeamDelivery[]) {
  const team = teamChannel(answers);
  const announce = createRequestAnnouncer(team);
  const hold = (times: number) => {
    for (let i = 0; i < times; i += 1) announce(PENDING_REQUEST);
  };
  return {
    ...team,
    hold,
    announce: async (times: number) => {
      hold(times);
      await team.flush();
    },
  };
}

describe("new request announcements", () => {
  const each = newRequestMessage(PENDING_REQUEST.requester);
  const note = moreRequestsMessage();

  test("posts 10 requests an hour, then one note, then waits", async () => {
    const t = announcerWith([]);
    await t.announce(25);
    expect(t.sent).toEqual([...Array(10).fill(each), note]);
    t.advance(MS_PER_HOUR - 1);
    await t.announce(1);
    expect(t.sent).toHaveLength(11);
    t.advance(1);
    await t.announce(12);
    expect(t.sent.slice(11)).toEqual([...Array(10).fill(each), note]);
  });

  test("a post failed twice frees its place", async () => {
    const t = announcerWith(["failed", "failed"]);
    await t.announce(1);
    await t.announce(10);
    expect(t.sent).toEqual(Array(12).fill(each));
  });

  test("a failed post after the note does not repeat the note", async () => {
    const t = announcerWith(["failed", "failed"]);
    await t.announce(11);
    await t.announce(5);
    expect(t.sent.slice(11)).toEqual([note, each]);
  });

  test("a note failed twice is sent again on the next request", async () => {
    const answers = Array<TeamDelivery>(10).fill("sent");
    const t = announcerWith([...answers, "failed", "failed"]);
    await t.announce(11);
    await t.announce(1);
    expect(t.sent.slice(10)).toEqual([note, note, note]);
  });

  test("a failed post from the last hour frees no place", async () => {
    const t = announcerWith(["failed", "failed"]);
    t.hold(10);
    t.advance(MS_PER_HOUR);
    t.hold(1);
    await t.flush();
    await t.announce(11);
    expect(t.sent.slice(11)).toEqual([...Array(10).fill(each), note]);
  });
});
