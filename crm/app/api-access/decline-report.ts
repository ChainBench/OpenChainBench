import { plural } from "@/components/ui";
import { type Acted, type SiteFailure, isSiteFailure } from "@/lib/api-access";
import type { TeamRefusal } from "@/lib/api-access-contract/team-contract";
import { ACCESS_SITE_HOST } from "@/lib/site";
import {
  type ActError,
  RECORD_REPAIR,
  failureText,
  isUnsure,
  problemText,
} from "./failure-text";

const SETTLED = ["illegal_transition", "not_found"] as const;
type Settled = (typeof SETTLED)[number];
type Refused = Exclude<ActError, Settled>;

const isSettled = (error: ActError): error is Settled =>
  SETTLED.some((s) => s === error);

type SpamRefusal = Exclude<TeamRefusal, Settled | "unreadable">;

const SPAM_REFUSALS: Record<SpamRefusal, string> = {
  conflict:
    "changed elsewhere at the same moment, so left as is. The list below " +
    "is up to date.",
  invalid:
    "refused by the site as malformed. Reload the page and try again; if " +
    "it happens again, redeploy the CRM after the site.",
};

const unreadableText = (count: number) =>
  count === 1
    ? `${ACCESS_SITE_HOST} cannot read its stored record; its Vercel ` +
      `logs name it, and ${RECORD_REPAIR}`
    : `${ACCESS_SITE_HOST} cannot read their stored records; its Vercel ` +
      `logs name them. For each one, ${RECORD_REPAIR}`;

function refusedText(error: Refused, count: number): string {
  if (isSiteFailure(error)) return failureText(error, "decline_spam");
  if (error === "unreadable") return unreadableText(count);
  return SPAM_REFUSALS[error];
}

type DeclineTally = {
  declined: number;
  settled: number;
  refused: readonly (readonly [Refused, number])[];
  unsure: readonly SiteFailure[];
  untried: number;
  complete: boolean;
};

const countEach = <T>(items: readonly T[]): [T, number][] =>
  [...new Set(items)].map((item) =>
    [item, items.filter((i) => i === item).length]);

export function tallyDeclines(asked: number, results: Acted[]): DeclineTally {
  const failures = results.flatMap((r) => (r.ok ? [] : [r.error]));
  const unsure = failures.filter(isUnsure);
  const refused = failures.filter(
    (f): f is Refused => !isSettled(f) && !isUnsure(f),
  );
  const untried = asked - results.length;
  return {
    declined: results.length - failures.length,
    settled: failures.filter(isSettled).length,
    refused: countEach(refused),
    unsure,
    untried,
    complete: refused.length + unsure.length + untried === 0,
  };
}

function outcomeLine({ declined, unsure }: DeclineTally): string {
  if (declined > 0) return `Declined ${plural(declined, "request")} as spam.`;
  return unsure.length > 0
    ? "No request was confirmed declined."
    : "No request was declined.";
}

export function declineText(tally: DeclineTally): string {
  const { settled, refused, unsure, untried } = tally;
  const lines = [outcomeLine(tally)];
  if (settled > 0) {
    lines.push(`${plural(settled, "request")} already decided ` +
      "or removed elsewhere; left as is.");
  }
  for (const [error, count] of refused) {
    lines.push(`${plural(count, "request")} not declined: ` +
      refusedText(error, count));
  }
  if (unsure.length > 0) {
    const problems = [...new Set(unsure)].map(problemText).join(" ");
    lines.push(`${plural(unsure.length, "request")} may or may not be ` +
      `declined: ${problems} Check the list below before trying again.`);
  }
  if (untried > 0) {
    lines.push(`${plural(untried, "request")} not tried, since the site ` +
      "stopped answering or refused the CRM. Those still waiting stay " +
      "selected.");
  }
  return lines.join(" ");
}
