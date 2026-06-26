"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, X } from "lucide-react";

type Status = "idle" | "submitting" | "ok" | "error";

type Props = {
  slug: string;
  onClose: () => void;
};

/**
 * The heavy report-form modal. Code-split out of the trigger via
 * `next/dynamic` so the form + icons + status state only land in the
 * client bundle when the user actually clicks "Report".
 */
export default function ReportSectionModal({ slug, onClose }: Props) {
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [wantsContact, setWantsContact] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Lock body scroll while the modal is mounted and close on Escape.
  // Effect lives in the modal (not the trigger) because the modal only
  // mounts when `open` is true, so we don't even need to gate on it.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  async function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "submitting") return;
    setStatus("submitting");
    setErrorMsg(null);
    try {
      const url = typeof window !== "undefined" ? new URL(window.location.href) : null;
      const chain = url?.searchParams.get("chain") ?? null;
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          chain,
          message,
          contact: wantsContact && contact ? contact : null,
          page: url?.toString() ?? "",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(
          typeof data?.error === "string"
            ? data.error
            : "Something went wrong. Try again."
        );
        setStatus("error");
        return;
      }
      setStatus("ok");
    } catch {
      setErrorMsg("Network error. Try again.");
      setStatus("error");
    }
  }

  const tooShort = message.trim().length < 5;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 backdrop-blur-sm p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg rounded-md border border-rule bg-paper shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-rule px-6 py-4">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink">
            Report a problem
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-ink-muted hover:text-ink transition-colors"
          >
            <X size={20} strokeWidth={2} />
          </button>
        </div>

        {status === "ok" ? (
          <div className="px-6 py-10 text-center flex flex-col items-center gap-3">
            <span
              className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-good/10 text-[var(--color-good)]"
              aria-hidden
            >
              <CheckCircle2 size={28} strokeWidth={2} />
            </span>
            <p className="display text-xl text-ink">Thanks, report received.</p>
            <p className="text-sm text-ink-muted max-w-sm leading-relaxed">
              {wantsContact && contact
                ? "A maintainer will take a look and reach out at the contact you left."
                : "A maintainer will take a look. Have a great day."}
            </p>
            <button
              onClick={onClose}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-ink bg-ink px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-paper hover:bg-paper hover:text-ink transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="px-6 py-5 space-y-4">
            <p className="text-sm text-ink-muted leading-relaxed">
              Spotted a wrong number, a missing provider, an outage, or
              anything off about this benchmark? Tell us, it goes straight
              to a maintainer.
            </p>
            <div>
              <label
                htmlFor="report-message"
                className="block text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint mb-2"
              >
                What&apos;s wrong?
              </label>
              <textarea
                id="report-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                maxLength={2000}
                required
                placeholder="Describe what you saw, when, and where (chain / provider / time range)."
                className="w-full rounded border border-rule bg-paper-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-ink"
              />
              <p className="mt-1 text-[10px] text-ink-faint tabular">
                {message.length} / 2000
              </p>
            </div>
            <div className="space-y-2">
              <label className="flex items-start gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={wantsContact}
                  onChange={(e) => setWantsContact(e.target.checked)}
                  className="mt-0.5 h-4 w-4 cursor-pointer accent-[var(--color-ink)]"
                />
                <span className="text-sm text-ink leading-snug">
                  I&apos;d like a reply
                  <span className="block text-xs text-ink-muted mt-0.5">
                    Leave an email, Telegram or GitHub handle so a maintainer can follow up.
                  </span>
                </span>
              </label>
              {wantsContact && (
                <input
                  id="report-contact"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  type="text"
                  maxLength={200}
                  autoFocus
                  placeholder="email, telegram, github handle…"
                  className="w-full rounded border border-rule bg-paper-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-ink"
                />
              )}
            </div>

            {errorMsg && (
              <p className="text-sm text-bad" role="alert">
                {errorMsg}
              </p>
            )}

            <div className="flex items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={status === "submitting" || tooShort}
                className="inline-flex items-center gap-1.5 rounded-md border border-ink bg-ink px-3.5 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-paper hover:bg-paper hover:text-ink transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {status === "submitting" && (
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                )}
                Send report
              </button>
              <button
                type="button"
                onClick={onClose}
                className="text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
