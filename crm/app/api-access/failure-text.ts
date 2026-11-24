import {
  type Acted,
  SITE_TIMEOUT_SECONDS,
  type SiteFailure,
  isSiteFailure,
} from "@/lib/api-access";
import {
  ADMIN_TOKEN_ENV,
  MIN_ADMIN_TOKEN_CHARS,
  NEXT_ADMIN_TOKEN_ENV,
  type TeamRefusal,
} from "@/lib/api-access-contract/team-contract";
import { ACCESS_HOST_ENV, ACCESS_SITE_HOST } from "@/lib/site";
import type { FormAction } from "./action-form";

export type ActError = Extract<Acted, { ok: false }>["error"];

const UNSURE_FAILURES: readonly SiteFailure[] = [
  "unreachable",
  "unavailable",
  "bad_answer",
  "site_error",
];

export const isUnsure = (error: ActError): error is SiteFailure =>
  UNSURE_FAILURES.some((f) => f === error);

const SITE_PROBLEMS: Record<SiteFailure, string> = {
  unreachable:
    `${ACCESS_SITE_HOST} could not be reached: no complete answer within ` +
    `${SITE_TIMEOUT_SECONDS} s, or a DNS, connection or certificate failure.`,
  unavailable: `${ACCESS_SITE_HOST} could not reach its database.`,
  unauthorized: `${ACCESS_SITE_HOST} refused the CRM's token.`,
  unconfigured:
    `${ADMIN_TOKEN_ENV} is missing on the CRM or the site, or on the site ` +
    `it or ${NEXT_ADMIN_TOKEN_ENV} is shorter than ${MIN_ADMIN_TOKEN_CHARS} ` +
    "characters.",
  bad_answer: `${ACCESS_SITE_HOST} sent an answer the CRM cannot read.`,
  site_error:
    `${ACCESS_SITE_HOST} hit an error; its Vercel logs have the details.`,
  redirected: `${ACCESS_SITE_HOST} redirected the CRM to another address.`,
  no_route:
    `${ACCESS_SITE_HOST} has no API access routes; it may run a version ` +
    "without them.",
};

const TRY_LATER = "Try again in a minute.";
const ADMIN_TOKEN_HINT =
  `Check that ${ADMIN_TOKEN_ENV} is set to the same value on Vercel ` +
  "(the site) and on Railway (the CRM), then redeploy.";
const ACCESS_HOST_HINT =
  `Set ${ACCESS_HOST_ENV} on Railway to the address the site answers on ` +
  "without redirecting (for example openchainbench.com, without www), " +
  "then redeploy the CRM.";

const SITE_HINTS: Record<SiteFailure, string> = {
  unreachable: TRY_LATER,
  unavailable: TRY_LATER,
  site_error: TRY_LATER,
  unauthorized: ADMIN_TOKEN_HINT,
  unconfigured: ADMIN_TOKEN_HINT,
  redirected: ACCESS_HOST_HINT,
  no_route:
    `If ${ACCESS_HOST_ENV} on Railway names the wrong site, correct it ` +
    "and redeploy the CRM; otherwise redeploy the site.",
  bad_answer:
    "The site and the CRM may be on different versions; redeploy the CRM " +
    "after the site.",
};

const MAYBE_APPLIED =
  "The action may or may not have been applied: check the list below " +
  "before trying again.";
const MAYBE_NEW_LINK =
  "The old link may already have stopped working, and no new link " +
  "reached the CRM: replace the status link again to get one.";

export const RECORD_REPAIR =
  "a developer has to repair the record in Redis, or delete it together " +
  "with its status entry, its status-link pointer and, if it had a key, " +
  "the key's entry in the key index, so that key stops working.";

const REFUSALS: Record<TeamRefusal, string> = {
  illegal_transition:
    "This request was already decided, from another tab or by a teammate. " +
    "Nothing was changed. The list below is up to date.",
  conflict:
    "Someone changed this request at the same moment. Nothing was " +
    "changed. The list below is up to date.",
  not_found:
    "This request no longer exists on the site. Nothing was changed. The " +
    "list below is up to date.",
  invalid:
    "The site refused this action as malformed. Nothing was changed. " +
    "Reload the page and try again; if it happens again, redeploy the CRM " +
    "after the site.",
  unreadable:
    `${ACCESS_SITE_HOST} cannot read this request's record, so nothing ` +
    `was changed. The site's Vercel logs name the record; ${RECORD_REPAIR}`,
};

const siteText = (failure: SiteFailure, outcome: string | null) =>
  [SITE_PROBLEMS[failure], outcome, SITE_HINTS[failure]]
    .filter(Boolean).join(" ");

export const problemText = (failure: SiteFailure) =>
  failure === "bad_answer"
    ? `${SITE_PROBLEMS[failure]} ${SITE_HINTS[failure]}`
    : SITE_PROBLEMS[failure];

export function failureText(
  error: ActError,
  action: FormAction,
): string {
  if (!isSiteFailure(error)) return REFUSALS[error];
  if (isUnsure(error)) {
    const maybe = action === "reissue_link" ? MAYBE_NEW_LINK : MAYBE_APPLIED;
    return `${problemText(error)} ${maybe}`;
  }
  const outcome = action === "decline_spam" ? null : "Nothing was changed.";
  return siteText(error, outcome);
}

export const listFailureText = (failure: SiteFailure) =>
  siteText(failure, "The requests cannot be shown.");
