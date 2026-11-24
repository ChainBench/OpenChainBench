import { randomUUID } from "node:crypto";
import type { Acted, createAccessClient } from "@/lib/api-access";
import {
  DECLINED_KEPT_DAYS,
  OLD_KEY_DELAY,
} from "@/lib/api-access-contract/contract";
import type { TeamAction } from "@/lib/api-access-contract/team-contract";
import { readAccessForm } from "./action-form";
import { declineText, tallyDeclines } from "./decline-report";
import { failureText } from "./failure-text";
import { SPAM_REASON } from "./spam";

type AccessClient = Pick<
  ReturnType<typeof createAccessClient>,
  "actOnRequest" | "declineEach"
>;

export type ActionSetup = {
  signedIn: () => Promise<boolean>;
  client: () => AccessClient;
  refresh: () => void;
};

export type Outcome =
  | { kind: "idle" }
  | {
      kind: "done";
      id: string;
      message: string;
      link: string | null;
      email: string | null;
    }
  | { kind: "failed"; id: string; message: string };

function doneMessage(
  action: TeamAction,
  acted: Extract<Acted, { ok: true }>,
): string {
  const { name, email, website } = acted.request.requester;
  switch (action.action) {
    case "approve":
      return `Approved ${name}. Their status page now offers the key; ` +
        `tell them at ${email}.`;
    case "decline":
      return `Declined ${name}. Their status page shows the reason for ` +
        `${DECLINED_KEPT_DAYS} days; tell them at ${email}.`;
    case "revoke": {
      const key = acted.request.key;
      if (!key) {
        return `Revoked ${name} (${website}). No key had been created; ` +
          `tell them at ${email}.`;
      }
      return `Revoked ${name} (${website}). The key ending in ${key.last4} ` +
        `stops working within ${OLD_KEY_DELAY}. Tell them at ${email}.`;
    }
    case "reissue_link":
      return `New status link for ${email}. Send it by email now: it ` +
        "disappears when you act on another request, switch tab or " +
        "reload, and cannot be shown again. The previous link no longer " +
        "works.";
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

async function declineAsSpam(
  ids: string[],
  { client, refresh }: ActionSetup,
): Promise<Outcome> {
  const results = await client().declineEach(ids, SPAM_REASON);
  refresh();
  const tally = tallyDeclines(ids.length, results);
  const message = declineText(tally);
  const id = randomUUID();
  return tally.complete
    ? { kind: "done", id, message, link: null, email: null }
    : { kind: "failed", id, message };
}

export async function performAccessAction(
  form: FormData,
  setup: ActionSetup,
): Promise<Outcome> {
  const failed = (message: string): Outcome =>
    ({ kind: "failed", id: randomUUID(), message });
  if (!(await setup.signedIn())) {
    return failed("Your session ended. Nothing was changed. Log in again.");
  }
  const read = readAccessForm(form);
  if (read.kind === "unreadable") return failed(read.message);
  if (read.kind === "decline_spam") return declineAsSpam(read.ids, setup);
  const acted = await setup.client().actOnRequest(read.id, read.action);
  setup.refresh();
  if (!acted.ok) return failed(failureText(acted.error, read.action.action));
  return {
    kind: "done",
    id: randomUUID(),
    message: doneMessage(read.action, acted),
    link: acted.link,
    email: acted.request.requester.email,
  };
}
