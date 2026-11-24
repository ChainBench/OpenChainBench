import { type ChangeEvent, useCallback, useState } from "react";
import {
  MAX_EMAIL,
  MAX_NAME,
  MAX_USE_CASE,
  MAX_WEBSITE,
  MIN_USE_CASE,
  type Requester,
} from "@/lib/api-access/contract";

export type Field = keyof Requester;

export const FIELDS: readonly {
  name: Field;
  label: string;
  hint?: string;
  error: string;
  type: "email" | "text" | "url" | "textarea";
  max: number;
  autoComplete?: string;
}[] = [
  {
    name: "email",
    label: "Email",
    hint:
      "We write to this address only about your key and about changes " +
      "to the endpoints.",
    error: "Enter an email address like name@example.com.",
    type: "email",
    max: MAX_EMAIL,
    autoComplete: "email",
  },
  {
    name: "name",
    label: "Your name or company",
    error:
      "Enter your name or the name of your company, up to " +
      `${MAX_NAME} characters.`,
    type: "text",
    max: MAX_NAME,
    autoComplete: "name",
  },
  {
    name: "website",
    label: "Site where the numbers will appear",
    hint: "The full address, starting with https:// or http://",
    error:
      "Enter the full address of your site, starting with https:// or " +
      "http://.",
    type: "url",
    max: MAX_WEBSITE,
    autoComplete: "url",
  },
  {
    name: "useCase",
    label: "What you will build",
    hint:
      "Which benchmarks, and how often you will call. " +
      `${MIN_USE_CASE} to ${MAX_USE_CASE.toLocaleString("en-US")} characters.`,
    error:
      "Describe what you will build in " +
      `${MIN_USE_CASE} to ${MAX_USE_CASE.toLocaleString("en-US")} ` +
      "characters, not counting spaces and blank lines at the start or end.",
    type: "textarea",
    max: MAX_USE_CASE,
  },
];

export const isField = (v: unknown): v is Field =>
  FIELDS.some((f) => f.name === v);

const hiddenCharError = (label: string) =>
  `"${label}" holds a character we cannot accept, often hidden in ` +
  "pasted text. Type it instead of pasting it.";

const fieldError = (
  field: (typeof FIELDS)[number],
  pasted: boolean,
) => (pasted ? hiddenCharError(field.label) : field.error);

export type FieldError = { field: Field; text: string };

export const fieldId = (field: Field) => `ar-${field}`;

export const fieldErrors = (invalid: Field[], pasted: Field[]) =>
  FIELDS.flatMap((field): FieldError[] =>
    invalid.includes(field.name)
      ? [{
        field: field.name,
        text: fieldError(field, pasted.includes(field.name)),
      }]
      : []);

export function FormField({
  field,
  error,
}: {
  field: (typeof FIELDS)[number];
  error: string | null;
}) {
  const invalid = error !== null;
  const id = fieldId(field.name);
  const [typed, setTyped] = useState(0);
  const counted = field.type === "textarea";
  const described = [
    field.hint ? `${id}-hint` : null,
    counted ? `${id}-count` : null,
    invalid ? `${id}-error` : null,
  ].filter(Boolean).join(" ") || undefined;
  const countRestored = useCallback((box: HTMLTextAreaElement | null) => {
    if (box) setTyped(box.value.length);
  }, []);
  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setTyped(event.currentTarget.value.length);
  }
  const control = {
    id,
    name: field.name,
    required: true,
    maxLength: field.max,
    autoComplete: field.autoComplete,
    "aria-invalid": invalid || undefined,
    "aria-describedby": described,
    className:
      "min-h-11 w-full rounded border bg-paper-soft px-3 py-2 text-sm " +
      "text-ink " +
      "focus:border-ink focus:outline-none " +
      (invalid ? "border-bad" : "border-ink-faint"),
  };
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {field.label}
      </label>
      {field.hint ? (
        <p id={`${id}-hint`} className="mt-0.5 text-[13px] text-ink-muted">
          {field.hint}
        </p>
      ) : null}
      {invalid ? (
        <p id={`${id}-error`} className="mt-1 text-sm text-bad-text">
          {error}
        </p>
      ) : null}
      <div className="mt-2">
        {counted ? (
          <textarea {...control} ref={countRestored} rows={5}
            onChange={handleChange} />
        ) : (
          <input {...control} type={field.type} />
        )}
      </div>
      {counted ? (
        <p id={`${id}-count`} className="mt-1 text-[13px] text-ink-muted">
          {typed.toLocaleString("en-US")} of{" "}
          {field.max.toLocaleString("en-US")} characters
        </p>
      ) : null}
    </div>
  );
}
