import { z } from "zod";
import {
  REQUEST_ID,
  STATUS_TOKEN,
  type StoreRefusal,
  accessStatusSchema,
  changeSchema,
  reasonSchema,
  statusCountsSchema,
  storedRequesterSchema,
} from "./contract";

export const teamActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("decline"), reason: reasonSchema }),
  z.object({ action: z.literal("revoke") }),
  z.object({ action: z.literal("reissue_link") }),
]);
export type TeamAction = z.infer<typeof teamActionSchema>;

const teamViewSchema = z.object({
  id: z.string().regex(REQUEST_ID),
  status: accessStatusSchema,
  requester: storedRequesterSchema,
  createdAt: z.number(),
  history: z.array(changeSchema),
  decidedAt: z.number().nullable(),
  reason: z.string().nullable(),
  key: z.object({ last4: z.string(), createdAt: z.number() }).nullable(),
});
export type TeamView = z.infer<typeof teamViewSchema>;

export const teamListSchema = z.object({
  requests: z.array(teamViewSchema),
  counts: statusCountsSchema,
  unreadable: z.array(z.string().regex(REQUEST_ID)),
});
export type TeamList = z.infer<typeof teamListSchema>;

export const teamActedSchema = z.object({
  request: teamViewSchema,
  token: z.string().regex(STATUS_TOKEN).optional(),
});
export type TeamActed = z.infer<typeof teamActedSchema>;

const TEAM_REFUSALS = [
  "not_found",
  "illegal_transition",
  "conflict",
  "invalid",
  "unreadable",
] as const;
export const teamRefusalSchema = z.object({ error: z.enum(TEAM_REFUSALS) });
export type TeamRefusal = z.infer<typeof teamRefusalSchema>["error"];

export const ADMIN_TOKEN_ENV = "API_ACCESS_ADMIN_TOKEN";
export const NEXT_ADMIN_TOKEN_ENV = `${ADMIN_TOKEN_ENV}_NEXT`;
export const MIN_ADMIN_TOKEN_CHARS = 32;

const TEAM_GATE_REFUSALS = ["unauthorized", "unconfigured"] as const;
export type TeamGateRefusal = (typeof TEAM_GATE_REFUSALS)[number];
const STORE_DOWN = "unavailable" satisfies StoreRefusal;
export const teamCallRefusalSchema = z.object({
  error: z.enum([...TEAM_GATE_REFUSALS, STORE_DOWN]),
});
