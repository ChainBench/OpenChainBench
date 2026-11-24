import { describe, expect, test } from "bun:test";
import {
  type ActionSetup,
  performAccessAction,
} from "@/app/api-access/access-action";
import { SECRET_CHARS } from "@/lib/api-access-contract/contract";
import type { TeamView } from "@/lib/api-access-contract/team-contract";
import { ROW } from "./team-view";

const TOKEN = "L".repeat(SECRET_CHARS);
const LINK = `https://openchainbench.com/api-access/status#${TOKEN}`;

function formOf(fields: Record<string, string>): () => FormData {
  return () => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      form.append(name, value);
    }
    return form;
  };
}

const approveForm = formOf({ action: "approve", id: ROW.id });
const spamForm = formOf({ action: "decline_spam", ids: ROW.id });
const newLinkForm = formOf({ action: "reissue_link", id: ROW.id });
const revokeForm = formOf({ action: "revoke", id: ROW.id });

function siteRecording(
  signedIn: boolean,
  link: string | null = null,
  acted: TeamView = ROW,
) {
  const calls: string[] = [];
  let refreshed = 0;
  const setup: ActionSetup = {
    signedIn: async () => signedIn,
    client: () => ({
      actOnRequest: async (id) => {
        calls.push(id);
        return { ok: true, request: acted, link };
      },
      declineEach: async (ids) => {
        calls.push(...ids);
        return [];
      },
    }),
    refresh: () => {
      refreshed += 1;
    },
  };
  return { setup, calls, refreshed: () => refreshed };
}

describe("an action from the API access page", () => {
  test.each([
    ["an approval", approveForm],
    ["a spam decline", spamForm],
  ])("without a session, %s does not reach the site", async (_, form) => {
    const site = siteRecording(false);
    const outcome = await performAccessAction(form(), site.setup);
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(site.calls).toEqual([]);
    expect(site.refreshed()).toBe(0);
  });

  test("with a session, it reaches the site once", async () => {
    const site = siteRecording(true);
    const outcome = await performAccessAction(approveForm(), site.setup);
    expect(outcome).toMatchObject({ kind: "done" });
    expect(site.calls).toEqual([ROW.id]);
    expect(site.refreshed()).toBe(1);
  });

  test("a new status link reaches the banner with the email", async () => {
    const site = siteRecording(true, LINK);
    const outcome = await performAccessAction(newLinkForm(), site.setup);
    expect(outcome).toMatchObject({
      kind: "done",
      link: LINK,
      email: ROW.requester.email,
    });
  });

  test.each([
    ["names the key that stops working", ROW,
      `key ending in ${ROW.key?.last4}`],
    ["says when no key was created", { ...ROW, key: null },
      "No key had been created"],
  ])("a revocation %s", async (_, acted, expected) => {
    const site = siteRecording(true, null, acted);
    const outcome = await performAccessAction(revokeForm(), site.setup);
    expect(outcome).toMatchObject({ kind: "done" });
    const message = outcome.kind === "done" ? outcome.message : "";
    expect(message).toContain(expected);
  });

  test("a spam decline the site did not finish is a failure", async () => {
    const site = siteRecording(true);
    const outcome = await performAccessAction(spamForm(), site.setup);
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(site.refreshed()).toBe(1);
  });
});
