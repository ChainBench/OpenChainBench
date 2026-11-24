import {
  REQUEST_ROUTE,
  hasHiddenChars,
  invalidRequestSchema,
  requestRefusalSchema,
  statusLink,
  tokenBodySchema,
} from "@/lib/api-access/contract";
import {
  minutesToWait,
  waitSeconds,
} from "@/lib/api-access/retry-wait";
import type { Refusal } from "./access-request-errors";
import { type Field, isField } from "./access-request-fields";

export type Editing = {
  kind: "editing";
  invalid: Field[];
  pasted: Field[];
  refusal: Refusal | null;
};
export type Phase = Editing | { kind: "sending" };
type Sent = { kind: "sent"; link: string };

const SEND_TIMEOUT_MS = 15_000;

export const editing = (
  refusal: Refusal | null,
  invalid: Field[] = [],
  pasted: Field[] = [],
): Editing => ({ kind: "editing", invalid, pasted, refusal });

export function refusalFor(
  status: number,
  data: unknown,
  sent: Record<string, unknown>,
): Editing {
  const rejected = invalidRequestSchema.safeParse(data);
  if (status === 400 && rejected.success) {
    const invalid = rejected.data.fields.filter(isField);
    if (invalid.length === 0) return editing({ kind: "unreadable" });
    const pasted = invalid.filter((field) => {
      const value = sent[field];
      return typeof value === "string" && hasHiddenChars(field, value.trim());
    });
    return editing(null, invalid, pasted);
  }
  const minutes = minutesToWait(waitSeconds(data));
  if (status === 429) return editing({ kind: "limited", minutes });
  const refused = requestRefusalSchema.safeParse(data);
  if (!refused.success) return editing({ kind: "unconfirmed" });
  const { error } = refused.data;
  return editing(error === "busy" ? { kind: error, minutes } : { kind: error });
}

export async function sendRequest(
  body: Record<string, unknown>,
): Promise<Phase | Sent> {
  let res: Response;
  try {
    res = await fetch(REQUEST_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    return editing({ kind: "unconfirmed" });
  }
  const data: unknown = await res.json().catch(() => null);
  const sent = tokenBodySchema.safeParse(data);
  if (res.status === 201 && sent.success) {
    return { kind: "sent", link: statusLink(sent.data.token) };
  }
  return refusalFor(res.status, data, body);
}
