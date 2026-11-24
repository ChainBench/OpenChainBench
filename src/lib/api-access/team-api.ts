import { checkBearer } from "@/lib/internal-bearer";
import { logAtMost } from "@/lib/rate-limit";
import type { AccessRequest, Decision } from "./access-request";
import type { ApiAccess } from "./api-access";
import { REQUEST_ID, accessStatusSchema } from "./contract";
import { orUnavailable, privateJson, readJsonBody } from "./http";
import { keyView } from "./requester-view";
import {
  ADMIN_TOKEN_ENV,
  MIN_ADMIN_TOKEN_CHARS,
  NEXT_ADMIN_TOKEN_ENV,
  type TeamAction,
  type TeamActed,
  type TeamGateRefusal,
  type TeamRefusal,
  type TeamList,
  type TeamView,
  teamActionSchema,
} from "./team-contract";

function teamView(req: AccessRequest): TeamView {
  const base = {
    id: req.id,
    status: req.status,
    requester: req.requester,
    createdAt: req.createdAt,
    history: req.history,
  };
  switch (req.status) {
    case "pending":
      return { ...base, decidedAt: null, reason: null, key: null };
    case "approved":
      return { ...base, decidedAt: req.approvedAt, reason: null,
        key: keyView(req.key) };
    case "declined":
      return { ...base, decidedAt: req.declinedAt, reason: req.reason,
        key: null };
    case "revoked":
      return { ...base, decidedAt: req.revokedAt, reason: null,
        key: keyView(req.lastKey) };
    default: {
      const unreachable: never = req;
      return unreachable;
    }
  }
}

const REFUSAL_STATUS: Partial<Record<TeamRefusal, number>> = {
  not_found: 404,
  invalid: 400,
};
const refusal = (error: TeamRefusal) =>
  privateJson({ error }, REFUSAL_STATUS[error] ?? 409);

const gateRefusal = (error: TeamGateRefusal, status: number) =>
  privateJson({ error }, status);

export function teamGate(req: Request): Response | null {
  const auth = checkBearer(req, [ADMIN_TOKEN_ENV, NEXT_ADMIN_TOKEN_ENV], {
    minLength: MIN_ADMIN_TOKEN_CHARS,
  });
  if (auth === "unconfigured") {
    logAtMost(1, "api-access-unconfigured", () => console.error(
      `${ADMIN_TOKEN_ENV} is missing, or it or ${NEXT_ADMIN_TOKEN_ENV} ` +
        `is shorter than ${MIN_ADMIN_TOKEN_CHARS} characters`,
    ));
    return gateRefusal("unconfigured", 503);
  }
  if (auth === "unauthorized") {
    return gateRefusal("unauthorized", 401);
  }
  return null;
}

export function listForTeam(
  req: Request,
  { access, now }: { access: ApiAccess; now: number },
): Promise<Response> {
  const asked = new URL(req.url).searchParams.get("status") ?? "pending";
  const parsed = accessStatusSchema.safeParse(asked);
  if (!parsed.success) {
    return Promise.resolve(refusal("invalid"));
  }
  const status = parsed.data;
  return orUnavailable(async () => {
    const { requests, counts, unreadable } = await access.list(status, now);
    return privateJson({
      requests: requests.map(teamView),
      counts,
      unreadable,
    } satisfies TeamList);
  });
}

function toDecision(
  action: Exclude<TeamAction, { action: "reissue_link" }>,
): Decision {
  switch (action.action) {
    case "approve":
      return { to: "approved" };
    case "decline":
      return { to: "declined", reason: action.reason };
    case "revoke":
      return { to: "revoked" };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

export async function actForTeam(
  req: Request,
  id: string,
  { access, now }: { access: ApiAccess; now: number },
): Promise<Response> {
  if (!REQUEST_ID.test(id)) return refusal("not_found");
  const parsed = teamActionSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return refusal("invalid");
  const action = parsed.data;
  return orUnavailable(async () => {
    if (action.action === "reissue_link") {
      const out = await access.reissueLink(id, now);
      if (!out.ok) return refusal(out.error);
      return privateJson({
        request: teamView(out.request),
        token: out.token,
      } satisfies TeamActed);
    }
    const out = await access.decideOn(id, toDecision(action), now);
    if (!out.ok) return refusal(out.error);
    return privateJson(
      { request: teamView(out.request) } satisfies TeamActed);
  });
}
