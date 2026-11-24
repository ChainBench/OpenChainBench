import { MS_PER_SECOND, SECONDS_PER_DAY } from "@/lib/time-constants";
import type { AccessRequest, KeyInfo } from "./access-request";
import { DECLINED_KEPT_DAYS } from "./contract";

const DECLINED_KEPT_MS = DECLINED_KEPT_DAYS * SECONDS_PER_DAY * MS_PER_SECOND;

export type KeyView = { last4: string; createdAt: number };

type Common = { requestedAt: number; email: string; website: string };

export type RequesterView = Common &
  (
    | { status: "pending" }
    | { status: "approved"; approvedAt: number; key: KeyView | null }
    | {
        status: "declined";
        declinedAt: number;
        deletedAt: number;
        reason: string;
      }
    | { status: "revoked"; revokedAt: number; lastKey: KeyView | null }
  );

export const keyView = (key: KeyInfo | null): KeyView | null =>
  key ? { last4: key.last4, createdAt: key.createdAt } : null;

export function requesterView(req: AccessRequest): RequesterView {
  const common: Common = {
    requestedAt: req.createdAt,
    email: req.requester.email,
    website: req.requester.website,
  };
  switch (req.status) {
    case "pending":
      return { ...common, status: "pending" };
    case "approved":
      return {
        ...common,
        status: "approved",
        approvedAt: req.approvedAt,
        key: keyView(req.key),
      };
    case "declined":
      return {
        ...common,
        status: "declined",
        declinedAt: req.declinedAt,
        deletedAt: req.declinedAt + DECLINED_KEPT_MS,
        reason: req.reason,
      };
    case "revoked":
      return {
        ...common,
        status: "revoked",
        revokedAt: req.revokedAt,
        lastKey: keyView(req.lastKey),
      };
    default: {
      const unreachable: never = req;
      return unreachable;
    }
  }
}
