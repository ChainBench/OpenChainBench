import type {
  KeyBody,
  LinkRefusal,
  RequestRefusal,
  StoreRefusal,
} from "./contract";
import type { KeyView, RequesterView } from "./requester-view";
import { waitSeconds } from "./retry-wait";

export type ShownKey = { key: string; view: RequesterView };
export type ApprovedView = Extract<RequesterView, { status: "approved" }>;
export type KeyOutcome =
  | { kind: "shown"; shown: ShownKey }
  | { kind: "changed" }
  | { kind: "trouble"; trouble: Trouble };
export type Answer = { status: number; body: unknown };
export type Trouble =
  | { kind: "unknown_link" }
  | { kind: "limited"; seconds: number }
  | { kind: "busy"; seconds: number }
  | { kind: "unreadable" }
  | { kind: "failed" };

const BUSY: RequestRefusal = "busy";
const UNREADABLE: StoreRefusal = "unreadable";
const UNKNOWN_LINK: LinkRefusal = "unknown_link";
const NOT_FOUND = 404;
const CREATED = 201;
const CONFLICT = 409;

function fieldsOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return Object.fromEntries(Object.entries(value));
}

type Check = (value: unknown) => boolean;
type ChecksOf<T> = { readonly [K in keyof T]-?: Check };
type ViewOf<S> = Omit<Extract<RequesterView, { status: S }>, "status">;
type Status = RequesterView["status"];

const isTime: Check = (value) => typeof value === "number";
const isText: Check = (value) => typeof value === "string";

const passes = (checks: Readonly<Record<string, Check>>, value: unknown) => {
  const f = fieldsOf(value);
  return f !== null &&
    Object.entries(checks).every(([name, check]) => check(f[name]));
};

const KEY_CHECKS: ChecksOf<KeyView> = { last4: isText, createdAt: isTime };
const keyOrNull: Check = (value) =>
  value === null || passes(KEY_CHECKS, value);

const COMMON_CHECKS: ChecksOf<ViewOf<"pending">> = {
  requestedAt: isTime,
  email: isText,
  website: isText,
};

const STATUS_CHECKS: {
  readonly [S in Status]: ChecksOf<Omit<ViewOf<S>, keyof ViewOf<"pending">>>;
} = {
  pending: {},
  approved: { approvedAt: isTime, key: keyOrNull },
  declined: { declinedAt: isTime, deletedAt: isTime, reason: isText },
  revoked: { revokedAt: isTime, lastKey: keyOrNull },
};

const isStatus = (value: unknown): value is Status =>
  Object.keys(STATUS_CHECKS).some((status) => status === value);

export function isView(value: unknown): value is RequesterView {
  const status = fieldsOf(value)?.status;
  return isStatus(status) &&
    passes(COMMON_CHECKS, value) &&
    passes(STATUS_CHECKS[status], value);
}

export function shownKey(body: unknown): ShownKey | null {
  const f = fieldsOf(body);
  if (f === null || typeof f.key !== "string" || !isView(f.view)) return null;
  return { key: f.key, view: f.view };
}

export function troubleOf({ status, body }: Answer): Trouble {
  const error = fieldsOf(body)?.error;
  if (status === NOT_FOUND && error === UNKNOWN_LINK) {
    return { kind: "unknown_link" };
  }
  if (status === 429) return { kind: "limited", seconds: waitSeconds(body) };
  if (status === 503 && error === BUSY) {
    return { kind: "busy", seconds: waitSeconds(body) };
  }
  if (status === 500 && error === UNREADABLE) return { kind: "unreadable" };
  return { kind: "failed" };
}

export function keyRequest(view: ApprovedView, token: string): KeyBody {
  return { token, replacing: view.key?.last4 ?? null };
}

export function keyOutcome(answer: Answer): KeyOutcome {
  const shown = answer.status === CREATED ? shownKey(answer.body) : null;
  if (shown) return { kind: "shown", shown };
  if (answer.status === CONFLICT) return { kind: "changed" };
  return { kind: "trouble", trouble: troubleOf(answer) };
}

export function keyChangedElsewhere(
  view: RequesterView,
  sent: KeyBody,
): boolean {
  return view.status === "approved" && view.key !== null &&
    view.key.last4 !== sent.replacing;
}
