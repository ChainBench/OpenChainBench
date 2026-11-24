"use client";

import {
  type ReactNode,
  type RefObject,
  useActionState,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";
import { Empty, bannerStyle, plural } from "@/components/ui";
import {
  ANNOUNCED_PER_HOUR,
  type AccessStatus,
  DECLINED_KEPT_DAYS,
  MAX_PENDING,
} from "@/lib/api-access-contract/contract";
import type { TeamView } from "@/lib/api-access-contract/team-contract";
import type { Outcome } from "./access-action";
import { takesFocus } from "./board-rules";
import { runAccessAction } from "./actions";
import {
  BUTTON,
  DANGER_STYLE,
  ForWhom,
  LINE_STYLE,
  MUTED,
  type Submit,
} from "./board-ui";
import { ConfirmedAction } from "./confirmed-action";
import { type RowProps, RowActions } from "./row-actions";
import { SPAM_REASON } from "./spam";

type Change = TeamView["history"][number];

const EVENT_LABELS: Record<Change["event"], string> = {
  requested: "Request sent",
  approved: "Approved",
  declined: "Declined",
  revoked: "Revoked",
  key_created: "Key created",
  key_replaced: "Key replaced",
  link_reissued: "Status link replaced",
};
const SOURCE_LABELS: Record<Change["source"], string> = {
  requester: "by the requester",
  team: "by the team",
};
const DECIDED_LABELS: Record<TeamView["status"], string> = {
  pending: "Decided",
  approved: "Approved",
  declined: "Declined",
  revoked: "Revoked",
};
const CHAT_NOTE =
  " New requests are also posted to the team chat when one is set up. " +
  `Each server of the site posts the first ${ANNOUNCED_PER_HOUR} it ` +
  "receives in an hour, then one note that more arrived.";

const utc = (ms: number) =>
  `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const isWebUrl = (s: string) => /^https?:\/\//i.test(s);

export function AccessBoard({
  rows,
  status,
  emptyText,
  failure,
}: {
  rows: TeamView[];
  status: AccessStatus;
  emptyText: string;
  failure: ReactNode;
}) {
  const [outcome, submit, pending] = useActionState<Outcome, FormData>(
    runAccessAction,
    { kind: "idle" },
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [unfocused, setUnfocused] = useState<string | null>(null);
  const startedFrom = useRef<Element | null>(null);
  function submitFrom(form: FormData) {
    startedFrom.current = document.activeElement;
    submit(form);
  }
  const bannerKey = outcome.kind === "idle" ? "idle" : outcome.id;
  const selectable = status === "pending";
  const chosen = selected.filter((id) => rows.some((r) => r.id === id));
  function handleToggle(id: string) {
    setSelected((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  }
  return (
    <div>
      <OutcomeBanner key={bannerKey} outcome={outcome}
        startedFrom={startedFrom} onUnfocused={setUnfocused} />
      <p role="status" className="mb-3 min-h-4 text-xs" style={MUTED}>
        {pending ? "Working… the list updates when the site answers." : null}
        {!pending && outcome.kind !== "idle" && unfocused === outcome.id ? (
          <span className="sr-only">{outcome.message}</span>
        ) : null}
      </p>
      {failure ?? (rows.length === 0 ? (
        <div className="panel px-4">
          <Empty text={selectable ? emptyText + CHAT_NOTE : emptyText} />
        </div>
      ) : (
        <RequestTable
          rows={rows}
          selectable={selectable}
          resetKey={bannerKey}
          chosen={chosen}
          onSelect={setSelected}
          onToggle={handleToggle}
          submit={submitFrom}
          pending={pending}
        />
      ))}
    </div>
  );
}

function RequestTable({
  rows,
  selectable,
  resetKey,
  chosen,
  onSelect,
  onToggle,
  submit,
  pending,
}: {
  rows: TeamView[];
  selectable: boolean;
  resetKey: string;
  chosen: string[];
  onSelect: (ids: string[]) => void;
  onToggle: (id: string) => void;
  submit: Submit;
  pending: boolean;
}) {
  return (
    <div className="panel overflow-x-auto px-2 py-2">
      {selectable ? (
        <SpamBar
          resetKey={resetKey}
          chosen={chosen}
          all={rows.map((r) => r.id)}
          onSelect={onSelect}
          submit={submit}
          pending={pending}
        />
      ) : null}
      <p className="px-2 pb-2 text-xs" style={MUTED}>
        Email and site are as given by the requester; nothing verifies
        them.
      </p>
      <table className="data">
        <thead>
          <tr>
            {selectable ? <th>Spam</th> : null}
            <th>Requester</th>
            <th>What they will build</th>
            <th>Dates and key</th>
            <th>History</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <RequestRow
              key={row.id}
              row={row}
              resetKey={resetKey}
              submit={submit}
              pending={pending}
              checked={selectable ? chosen.includes(row.id) : null}
              onToggle={onToggle}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const selectAllLabel = (count: number) =>
  count === 1 ? "Select it as spam" : `Select all ${count} as spam`;

function SpamBar({ resetKey, chosen, all, onSelect, submit, pending }: {
  resetKey: string;
  chosen: string[];
  all: string[];
  onSelect: (ids: string[]) => void;
  submit: Submit;
  pending: boolean;
}) {
  const selectableIds = all.slice(0, MAX_PENDING);
  const count = plural(chosen.length, "request");
  const allChosen = chosen.length === selectableIds.length;
  return (
    <div className="flex flex-wrap items-start gap-2 px-2 pb-3 text-xs">
      <button type="button" className={BUTTON} style={LINE_STYLE}
        onClick={() => onSelect(allChosen ? [] : selectableIds)}>
        {allChosen
          ? "Clear selection"
          : selectAllLabel(selectableIds.length)}
      </button>
      {chosen.length > 0 ? (
        <ConfirmedAction
          resetKey={resetKey}
          trigger={`Decline ${count} as spam`}
          forWhom={null}
          question={
            `Decline ${count} as spam? For the next ${DECLINED_KEPT_DAYS} ` +
            `days, each status page will say: "${SPAM_REASON}" Then each ` +
            "request and its status link are deleted. This cannot be undone."
          }
          confirm={{
            action: "decline_spam",
            label: `Decline ${count} as spam`,
          }}
          keep={chosen.length === 1 ? "Leave it waiting" : "Leave them waiting"}
          tone={DANGER_STYLE}
          submit={submit}
          pending={pending}
        >
          {chosen.map((id) => (
            <input key={id} type="hidden" name="ids" value={id} />
          ))}
        </ConfirmedAction>
      ) : null}
    </div>
  );
}

const LINK_SUBJECT = "Your new OpenChainBench status link";

function mailto(email: string, link: string | null): string {
  if (!link) return `mailto:${email}`;
  const body =
    `Here is your new private status link: ${link}\r\n\r\n` +
    "Your previous link no longer works. Keep this one private.";
  return `mailto:${email}?subject=${encodeURIComponent(LINK_SUBJECT)}` +
    `&body=${encodeURIComponent(body)}`;
}

function OutcomeBanner({
  outcome,
  startedFrom,
  onUnfocused,
}: {
  outcome: Outcome;
  startedFrom: RefObject<Element | null>;
  onUnfocused: (id: string) => void;
}) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const messageId = useId();
  const id = outcome.kind === "idle" ? null : outcome.id;
  const placeFocus = useCallback((el: HTMLDivElement | null) => {
    if (!el || !id) return;
    const places = {
      body: document.body,
      pressed: startedFrom.current,
      banner: el,
    };
    if (takesFocus(document.activeElement, places)) el.focus();
    else onUnfocused(id);
  }, [id, onUnfocused, startedFrom]);
  if (outcome.kind === "idle") return null;
  const tone = outcome.kind === "done" ? "var(--good)" : "var(--warn)";
  const link = outcome.kind === "done" ? outcome.link : null;
  const email = outcome.kind === "done" ? outcome.email : null;
  async function handleCopy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }
  return (
    <div
      ref={placeFocus}
      tabIndex={-1}
      role="group"
      aria-labelledby={messageId}
      className="panel mb-4 px-4 py-3 text-xs"
      style={bannerStyle(tone)}
    >
      <p id={messageId}>{outcome.message}</p>
      {email ? (
        <a href={mailto(email, link)} className="mt-2 inline-block underline">
          {link ? `Email the new link to ${email}` : `Write to ${email}`}
        </a>
      ) : null}
      {link ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="mono break-all">{link}</code>
          <button type="button" className={BUTTON} style={LINE_STYLE}
            onClick={handleCopy}>
            Copy status link
          </button>
          <span role="status">
            {copy === "copied" ? "Copied." : null}
            {copy === "failed"
              ? "Copy failed. Select the link and copy it."
              : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function History({ changes, name }: { changes: Change[]; name: string }) {
  return (
    <details>
      <summary className="cursor-pointer">
        {plural(changes.length, "change")}
        <ForWhom name={name} />
      </summary>
      <ol className="mono mt-1 space-y-0.5">
        {changes.map((h, i) => (
          <li key={i}>
            {utc(h.at)} {EVENT_LABELS[h.event]} {SOURCE_LABELS[h.source]}
          </li>
        ))}
      </ol>
    </details>
  );
}

function RequestRow({ checked, onToggle, ...props }: RowProps & {
  checked: boolean | null;
  onToggle: (id: string) => void;
}) {
  const { row } = props;
  const { name, email, website, useCase } = row.requester;
  return (
    <tr>
      {checked === null ? null : (
        <td>
          <input type="checkbox" checked={checked}
            aria-label={`Select ${name} as spam`}
            onChange={() => onToggle(row.id)} />
        </td>
      )}
      <td>
        <p className="break-words">{name}</p>
        <p className="mono" style={MUTED}>{email}</p>
        {isWebUrl(website) ? (
          <a href={website} target="_blank" rel="noopener noreferrer"
            className="break-all underline" style={MUTED}>
            {website}
          </a>
        ) : (
          <p className="break-all">{website}</p>
        )}
      </td>
      <td className="max-w-xs whitespace-pre-line break-words">{useCase}</td>
      <td className="mono whitespace-nowrap">
        <p>Requested {utc(row.createdAt)}</p>
        {row.decidedAt ? (
          <p>{DECIDED_LABELS[row.status]} {utc(row.decidedAt)}</p>
        ) : null}
        {row.key ? (
          <p>
            {row.status === "revoked" ? "Revoked key" : "Key"} ocb_…
            {row.key.last4}
          </p>
        ) : null}
        {row.reason ? (
          <p className="whitespace-normal" style={MUTED}>
            Reason: {row.reason}
          </p>
        ) : null}
      </td>
      <td>
        <History changes={row.history} name={name} />
      </td>
      <td>
        <RowActions {...props} />
      </td>
    </tr>
  );
}
