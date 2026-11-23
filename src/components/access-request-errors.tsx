import { type MouseEvent, type ReactNode, type Ref, useId } from "react";
import type { RequestRefusal } from "@/lib/api-access/contract";
import { minutesText } from "@/lib/api-access/retry-wait";
import { type FieldError, fieldId } from "./access-request-fields";

export type Refusal =
  | { kind: "limited" | "busy"; minutes: number }
  | { kind: Exclude<RequestRefusal, "busy"> }
  | { kind: "unreadable" }
  | { kind: "unconfirmed" };

const inMinutes = (minutes: number) => `in ${minutesText(minutes)}`;

export const ALERT_BOX =
  "rounded-lg border-l-4 border-bad bg-paper-soft px-4 py-3 text-sm";

export function Mail({ to }: { to: string }) {
  return (
    <a className="lnk" href={`mailto:${to}`}>
      {to}
    </a>
  );
}

function refusalText(refusal: Refusal, mail: ReactNode): [string, ReactNode] {
  switch (refusal.kind) {
    case "limited":
      return [
        "Your network sent too many key requests. Your request was not " +
          "saved.",
        <>
          Try again {inMinutes(refusal.minutes)}, or write to {mail} with
          the same details.
        </>,
      ];
    case "busy":
      return [
        "We are receiving too many key requests right now. Your request " +
          "was not saved.",
        <>
          Try again {inMinutes(refusal.minutes)}, or write to {mail} with
          the same details.
        </>,
      ];
    case "queue_full":
      return [
        "Too many requests are waiting for review, so yours was not " +
          "saved.",
        <>Write to {mail} with the same details; we read every message.</>,
      ];
    case "not_saved":
      return [
        "We could not reach our database, so your request was not saved.",
        <>
          Nothing reached our team. Try again in a few minutes, or write to
          {" "}{mail} with the same details.
        </>,
      ];
    case "unreadable":
      return [
        "We could not read the request your browser sent. Your request " +
          "was not saved.",
        <>
          Reload the page and send it again, or write to {mail} with the
          same details.
        </>,
      ];
    case "unconfirmed":
      return [
        "We could not tell whether your request was saved.",
        <>
          It may already be waiting for review, and sending it again would
          create a second request. Write to {mail} from the email you
          entered: we will check and send you a status link, or ask you to
          send the form again.
        </>,
      ];
    default: {
      const unreachable: never = refusal;
      return unreachable;
    }
  }
}

type AlertBoxProps = {
  ref: Ref<HTMLDivElement>;
  title: ReactNode;
  children: ReactNode;
};

function AlertBox({ ref, title, children }: AlertBoxProps) {
  const titleId = useId();
  const detailId = useId();
  return (
    <div ref={ref} tabIndex={-1} role="group" aria-labelledby={titleId}
      aria-describedby={detailId} className={ALERT_BOX}>
      <p id={titleId} className="font-medium text-ink">{title}</p>
      <div id={detailId} className="mt-1">{children}</div>
    </div>
  );
}

export function ErrorSummary({
  errors,
  refusal,
  contactEmail,
  ref,
}: {
  errors: FieldError[];
  refusal: Refusal | null;
  contactEmail: string;
  ref: Ref<HTMLDivElement>;
}) {
  if (refusal) {
    const [title, next] = refusalText(refusal, <Mail to={contactEmail} />);
    return (
      <AlertBox ref={ref} title={title}>
        <p className="text-ink-soft">{next}</p>
      </AlertBox>
    );
  }
  if (errors.length === 0) return null;
  const count =
    errors.length === 1
      ? "One field needs"
      : `${errors.length} fields need`;
  return (
    <AlertBox ref={ref} title={`${count} fixing. Your request was not saved.`}>
      <ul className="space-y-1">
        {errors.map(({ field, text }) => (
          <li key={field}>
            <a
              className="lnk text-bad-text"
              href={`#${fieldId(field)}`}
              onClick={handleJumpToField}
            >
              {text}
            </a>
          </li>
        ))}
      </ul>
    </AlertBox>
  );
}

function handleJumpToField(event: MouseEvent<HTMLAnchorElement>) {
  const id = event.currentTarget.hash.slice(1);
  const control = document.getElementById(id);
  if (!control) return;
  event.preventDefault();
  document.querySelector(`label[for="${id}"]`)?.scrollIntoView();
  control.focus({ preventScroll: true });
}
