import { z } from "zod";

export const MAX_EMAIL = 254;
export const MAX_NAME = 120;
export const MAX_WEBSITE = 300;
export const MIN_USE_CASE = 20;
export const MAX_USE_CASE = 1000;
export const MAX_REASON = 500;
export const KEYED_PER_MINUTE = 600;
export const KEY_CACHE_SECONDS = 30;
export const NEW_KEY_DELAY_SECONDS = 5;
export const OUTAGE_KEY_GRACE_MINUTES = 5;
export const OLD_KEY_DELAY =
  `${KEY_CACHE_SECONDS} seconds, or ${OUTAGE_KEY_GRACE_MINUTES} minutes ` +
  "during an outage of the site's database";
export const MAX_PENDING = 200;
export const DECLINED_KEPT_DAYS = 30;
export const DECLINED_KEPT =
  `${DECLINED_KEPT_DAYS} days after the decision`;
export const ANNOUNCED_PER_HOUR = 10;

export const ACCESS_STATUSES = [
  "pending",
  "approved",
  "declined",
  "revoked",
] as const;
export const accessStatusSchema = z.enum(ACCESS_STATUSES);
export type AccessStatus = z.infer<typeof accessStatusSchema>;

export const statusCountsSchema = z.record(accessStatusSchema, z.number());
export type StatusCounts = z.infer<typeof statusCountsSchema>;

export const SECRET_CHARS = 43;
export const TEAM_ROUTE = "/api/internal/api-access";
export const STATUS_PAGE_PATH = "/api-access/status";
export const REQUEST_PAGE_PATH = "/api-access";
export const REQUEST_ROUTE = "/api/api-access/requests";
export const STATUS_ROUTE = "/api/api-access/status";
export const KEY_ROUTE = "/api/api-access/key";
export const statusLink = (token: string) => `${STATUS_PAGE_PATH}#${token}`;
export const REQUEST_ID = /^[0-9a-f-]{36}$/;
export const STATUS_TOKEN = new RegExp(`^[0-9A-Za-z]{${SECRET_CHARS}}$`);
export const KEY_SUFFIX_CHARS = 4;

export const tokenBodySchema = z.object({
  token: z.string().regex(STATUS_TOKEN),
});
export type TokenBody = z.infer<typeof tokenBodySchema>;
export const keyBodySchema = tokenBodySchema.extend({
  replacing: z.string().length(KEY_SUFFIX_CHARS).nullable(),
});
export type KeyBody = z.infer<typeof keyBodySchema>;

const HIDDEN_CHARS =
  "\\u0000-\\u0008\\u000b-\\u001f\\u007f\\u00ad\\u061c\\u115f\\u1160" +
  "\\u180e\\u200b\\u200e\\u200f\\u2028-\\u202e\\u2060-\\u2064" +
  "\\u2066-\\u2069\\u3164\\ufeff\\u{e0000}-\\u{e007f}";
const JOINERS = "\\u200c\\u200d";
const HIDDEN_IN_LINE = new RegExp(`[\\t\\n${HIDDEN_CHARS}]`, "u");
const HIDDEN_IN_URL = new RegExp(`[\\t\\n${JOINERS}${HIDDEN_CHARS}]`, "u");
const HIDDEN_IN_TEXT = new RegExp(`[${HIDDEN_CHARS}]`, "u");
const asOneLineBreak = (s: string) => s.replace(/\r\n?/g, "\n");

type RequesterField = "email" | "name" | "website" | "useCase";

export function hasHiddenChars(field: RequesterField, value: string) {
  switch (field) {
    case "name":
      return HIDDEN_IN_LINE.test(value);
    case "website":
      return HIDDEN_IN_URL.test(value);
    case "useCase":
      return HIDDEN_IN_TEXT.test(asOneLineBreak(value));
    case "email":
      return HIDDEN_IN_URL.test(value);
  }
}

const website = z
  .string()
  .trim()
  .max(MAX_WEBSITE)
  .refine((s) => !hasHiddenChars("website", s))
  .pipe(z.url({ protocol: /^https?$/ }));

export const requesterSchema = z.object({
  email: z.string().trim().toLowerCase().max(MAX_EMAIL).pipe(z.email()),
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_NAME)
    .refine((s) => !hasHiddenChars("name", s)),
  website,
  useCase: z
    .string()
    .overwrite(asOneLineBreak)
    .trim()
    .min(MIN_USE_CASE)
    .max(MAX_USE_CASE)
    .refine((s) => !hasHiddenChars("useCase", s)),
});
export type Requester = z.infer<typeof requesterSchema>;

export const invalidRequestSchema = z.object({
  error: z.literal("invalid"),
  fields: z.array(z.string()),
});
export type InvalidRequest = z.infer<typeof invalidRequestSchema>;

const REQUEST_REFUSALS = ["busy", "queue_full", "not_saved"] as const;
export const requestRefusalSchema = z.object({
  error: z.enum(REQUEST_REFUSALS),
});
export type RequestRefusal = z.infer<typeof requestRefusalSchema>["error"];

export type StoreRefusal = "unavailable" | "unreadable";
export type LinkRefusal = "unknown_link";
export type KeyRefusal = "not_approved" | "key_changed" | "conflict";

export const storedRequesterSchema = z.object({
  email: z.string(),
  name: z.string(),
  website: z.string(),
  useCase: z.string(),
});

export const reasonSchema = z.string().trim().min(1).max(MAX_REASON);

const historyEventSchema = z.enum([
  "requested",
  "approved",
  "declined",
  "revoked",
  "key_created",
  "key_replaced",
  "link_reissued",
]);
export type HistoryEvent = z.infer<typeof historyEventSchema>;

const sourceSchema = z.enum(["requester", "team"]);

export const changeSchema = z.object({
  event: historyEventSchema,
  at: z.number(),
  source: sourceSchema,
});
