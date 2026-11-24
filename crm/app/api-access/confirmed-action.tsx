import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { useFormStatus } from "react-dom";
import type { FormAction } from "./action-form";
import { type Confirmation, staysOpen } from "./board-rules";
import { BUTTON, ForWhom, LINE_STYLE, type Submit } from "./board-ui";

function ConfirmButton({ action, label, forWhom, tone, disabled }: {
  action: FormAction;
  label: string;
  forWhom: string | null;
  tone: CSSProperties;
  disabled: boolean;
}) {
  const sending = useFormStatus().pending;
  return (
    <button type="submit" name="action" value={action}
      disabled={disabled} className={BUTTON} style={tone}>
      {sending ? "Working…" : label}
      {sending ? null : <ForWhom name={forWhom} />}
    </button>
  );
}

export function ConfirmedAction({
  resetKey,
  lead,
  trigger,
  forWhom,
  question,
  confirm,
  keep,
  tone,
  submit,
  pending,
  children,
}: {
  resetKey: string;
  lead?: ReactNode;
  trigger: string;
  forWhom: string | null;
  question: string;
  confirm: { action: FormAction; label: string };
  keep: string;
  tone: CSSProperties;
  submit: Submit;
  pending: boolean;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState<Confirmation>(null);
  const open = staysOpen(opened, resetKey);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const questionId = useId();
  function send(form: FormData) {
    setOpened({ sentWith: resetKey });
    submit(form);
  }
  function handleKeep() {
    setOpened(null);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }
  function handleKeyDown(event: KeyboardEvent<HTMLFieldSetElement>) {
    if (event.key === "Escape" && !pending) handleKeep();
  }
  if (!open) {
    return (
      <>
        {lead}
        <button ref={triggerRef} type="button" disabled={pending}
          className={BUTTON} style={tone}
          onClick={() => setOpened({ sentWith: null })}>
          {trigger}
          <ForWhom name={forWhom} />
        </button>
      </>
    );
  }
  return (
    <form action={send} className="max-w-56">
      <fieldset className="flex flex-col gap-2" aria-describedby={questionId}
        onKeyDown={handleKeyDown}>
        <legend className="sr-only">
          {trigger}
          <ForWhom name={forWhom} />
        </legend>
        {lead}
        {children}
        <p id={questionId} className="[overflow-wrap:anywhere]">{question}</p>
        <ConfirmButton action={confirm.action} label={confirm.label}
          forWhom={forWhom} tone={tone} disabled={pending} />
        <button type="button" autoFocus disabled={pending} className={BUTTON}
          style={LINE_STYLE} onClick={handleKeep}>
          {keep}
        </button>
      </fieldset>
    </form>
  );
}
