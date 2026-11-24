import { z } from "zod";
import {
  MAX_PENDING,
  REQUEST_ID,
} from "@/lib/api-access-contract/contract";
import {
  type TeamAction,
  teamActionSchema,
} from "@/lib/api-access-contract/team-contract";

export type FormAction = TeamAction["action"] | "decline_spam";

type AccessForm =
  | { kind: "decline_spam"; ids: string[] }
  | { kind: "act"; id: string; action: TeamAction }
  | { kind: "unreadable"; message: string };

const targetSchema = z.object({ id: z.string().regex(REQUEST_ID) });
const spamIdsSchema = z
  .array(z.string().regex(REQUEST_ID))
  .min(1)
  .max(MAX_PENDING);

const unreadable = (message: string): AccessForm =>
  ({ kind: "unreadable", message });

export function readAccessForm(form: FormData): AccessForm {
  const fields = Object.fromEntries(form);
  if (fields.action === "decline_spam") {
    const ids = spamIdsSchema.safeParse(form.getAll("ids"));
    return ids.success
      ? { kind: "decline_spam", ids: ids.data }
      : unreadable("No request was selected. Nothing was changed.");
  }
  const target = targetSchema.safeParse(fields);
  const action = teamActionSchema.safeParse(fields);
  if (target.success && action.success) {
    return { kind: "act", id: target.data.id, action: action.data };
  }
  return unreadable(fields.action === "decline"
    ? "A reason is needed to decline. Nothing was changed."
    : "The form could not be read. Nothing was changed; reload the page.");
}
