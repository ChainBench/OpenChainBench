import { useState } from "react";
import {
  DECLINED_KEPT_DAYS,
  MAX_REASON,
  OLD_KEY_DELAY,
} from "@/lib/api-access-contract/contract";
import type { TeamView } from "@/lib/api-access-contract/team-contract";
import {
  BUTTON,
  DANGER_STYLE,
  FIELD_STYLE,
  ForWhom,
  LINE_STYLE,
  MUTED,
  type Submit,
} from "./board-ui";
import { ConfirmedAction } from "./confirmed-action";

const APPROVE_STYLE = { borderColor: "var(--good)", color: "var(--good)" };

export type RowProps = {
  row: TeamView;
  resetKey: string;
  submit: Submit;
  pending: boolean;
};

function NewLinkButton({ row, resetKey, submit, pending }: RowProps) {
  return (
    <ConfirmedAction
      resetKey={resetKey}
      trigger="Replace status link"
      forWhom={row.requester.name}
      question={
        "Replace the status link? The requester's current link stops " +
        "working; send them the new one by email."
      }
      confirm={{ action: "reissue_link", label: "Replace status link" }}
      keep="Keep current link"
      tone={LINE_STYLE}
      submit={submit}
      pending={pending}
    >
      <input type="hidden" name="id" value={row.id} />
    </ConfirmedAction>
  );
}

function PendingActions(props: RowProps) {
  const { row, resetKey, submit, pending } = props;
  const { name } = row.requester;
  const [reason, setReason] = useState("");
  return (
    <div className="flex flex-col gap-2">
      <form action={submit}>
        <input type="hidden" name="id" value={row.id} />
        <button type="submit" name="action" value="approve"
          disabled={pending} className={BUTTON} style={APPROVE_STYLE}>
          Approve
          <ForWhom name={name} />
        </button>
      </form>
      <div className="flex flex-col gap-1">
        <ConfirmedAction
          resetKey={resetKey}
          lead={
            <>
              <label htmlFor={`reason-${row.id}`} className="text-xs"
                style={MUTED}>
                Reason for declining, shown to the requester
                <ForWhom name={name} />
              </label>
              <input id={`reason-${row.id}`} name="reason" required
                maxLength={MAX_REASON} value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="rounded-md border bg-transparent px-2 py-1 text-xs"
                style={FIELD_STYLE} />
            </>
          }
          trigger="Decline"
          forWhom={name}
          question={
            `Decline ${name}? Their status page will show your reason ` +
            `for ${DECLINED_KEPT_DAYS} days. Then the request is deleted ` +
            "from this list and their status link stops working. This " +
            "cannot be undone."
          }
          confirm={{ action: "decline", label: "Decline" }}
          keep="Leave it waiting"
          tone={DANGER_STYLE}
          submit={submit}
          pending={pending}
        >
          <input type="hidden" name="id" value={row.id} />
        </ConfirmedAction>
      </div>
      <NewLinkButton {...props} />
    </div>
  );
}

function revokeQuestion(row: TeamView): string {
  const site = row.requester.website;
  if (!row.key) {
    return `Revoke access for ${site}? When this list loaded, no key had ` +
      "been created. Any key created since stops working within " +
      `${OLD_KEY_DELAY}. This cannot be undone.`;
  }
  return `Revoke access for ${site}? When this list loaded, the key was ` +
    `ocb_…${row.key.last4}. The current key stops working within ` +
    `${OLD_KEY_DELAY}. This cannot be undone.`;
}

export function RowActions(props: RowProps) {
  const { row, resetKey, submit, pending } = props;
  if (row.status === "pending") return <PendingActions {...props} />;
  if (row.status !== "approved") return null;
  return (
    <div className="flex flex-col gap-2">
      <NewLinkButton {...props} />
      <ConfirmedAction
        resetKey={resetKey}
        trigger="Revoke access"
        forWhom={row.requester.name}
        question={revokeQuestion(row)}
        confirm={{ action: "revoke", label: "Revoke access" }}
        keep="Keep access"
        tone={DANGER_STYLE}
        submit={submit}
        pending={pending}
      >
        <input type="hidden" name="id" value={row.id} />
      </ConfirmedAction>
    </div>
  );
}
