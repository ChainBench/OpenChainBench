"use client";

import { type FormEvent, useCallback, useState } from "react";
import { SectionRule } from "@/components/section-rule";
import { useHydrated } from "@/hooks/use-hydrated";
import { editing, type Phase, sendRequest } from "./access-request-answer";
import {
  ALERT_BOX,
  ErrorSummary,
  Mail,
} from "./access-request-errors";
import { FIELDS, FormField, fieldErrors } from "./access-request-fields";

const NOTE = "text-[13px] leading-relaxed text-ink-muted";
const OFFSCREEN = "absolute -left-[9999px] h-px w-px overflow-hidden";
const SUBMIT =
  "btn-primary disabled:cursor-not-allowed disabled:opacity-60";

function HoneypotField() {
  return (
    <div aria-hidden="true" className={OFFSCREEN}>
      <label htmlFor="ar-ocb-check">Leave this field empty</label>
      <input
        id="ar-ocb-check"
        name="ocb_check"
        tabIndex={-1}
        autoComplete="off"
      />
    </div>
  );
}

export function AccessRequestForm({ contactEmail }: { contactEmail: string }) {
  const [phase, setPhase] = useState<Phase>(editing(null));
  const focusSummary = useCallback((box: HTMLDivElement | null) => {
    box?.focus();
  }, []);
  const hydrated = useHydrated();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase.kind === "sending") return;
    const form = event.currentTarget;
    setPhase({ kind: "sending" });
    const next = await sendRequest(Object.fromEntries(new FormData(form)));
    if (next.kind === "sent") {
      window.location.replace(next.link);
      return;
    }
    setPhase(next);
  }

  const { invalid, pasted, refusal } =
    phase.kind === "editing" ? phase : editing(null);
  const errors = fieldErrors(invalid, pasted);
  return (
    <section>
      <SectionRule label="Request a key" />
      <noscript>
        <p className={ALERT_BOX}>
          This form needs JavaScript. Turn it on and reload, or write to{" "}
          <Mail to={contactEmail} /> with your email, site and what you will
          build.
        </p>
      </noscript>
      <form
        method="post"
        noValidate
        onSubmit={(event) => void handleSubmit(event)}
        className="space-y-5"
      >
        <ErrorSummary
          ref={focusSummary}
          errors={errors}
          refusal={refusal}
          contactEmail={contactEmail}
        />
        {FIELDS.map((field) => (
          <FormField
            key={field.name}
            field={field}
            error={
              errors.find((e) => e.field === field.name)?.text ?? null
            }
          />
        ))}
        <HoneypotField />
        <button
          type="submit"
          disabled={!hydrated || phase.kind === "sending"}
          className={SUBMIT}
        >
          {submitLabel(phase)}
        </button>
        {!hydrated && (
          <p className={`${NOTE} noscript:hidden`}>
            The form is still loading. If the button stays grey, write to{" "}
            <Mail to={contactEmail} /> instead.
          </p>
        )}
        <p className={NOTE}>
          Each request is reviewed by a person. Right after sending, you get a
          private status link where the decision appears.
        </p>
      </form>
    </section>
  );
}

function submitLabel(phase: Phase): string {
  if (phase.kind === "sending") return "Sending…";
  if (phase.refusal?.kind === "unconfirmed") return "Send a second request";
  return "Request a key";
}
