"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";

type Status = "idle" | "submitting" | "ok" | "error";

type Props = {
  slug: string;
};

/**
 * Discreet "Report a problem" trigger + modal. Posts to /api/report which
 * forwards to a Slack webhook server-side — the URL never reaches the client.
 */
export function ReportSection({ slug }: Props) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    if (status === "ok") {
      setMessage("");
      setContact("");
      setStatus("idle");
      setErrorMsg(null);
    }
  }

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
          contact: contact || null,
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
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-md border border-ink bg-paper px-3.5 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-ink hover:bg-ink hover:text-paper transition-colors"
      >
        <AlertTriangle size={14} strokeWidth={2} />
        Report
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 backdrop-blur-sm p-4 sm:p-8"
          onClick={close}
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
                onClick={close}
                aria-label="Close"
                className="text-ink-muted hover:text-ink transition-colors"
              >
                <X size={20} strokeWidth={2} />
              </button>
            </div>

            {status === "ok" ? (
              <div className="px-6 py-8 text-center space-y-2">
                <p className="text-base text-ink">Thanks — report received.</p>
                <p className="text-sm text-ink-muted">
                  A maintainer will look into it. We may reach out if you left a
                  contact.
                </p>
                <button
                  onClick={close}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-ink bg-ink px-3.5 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-paper hover:bg-paper hover:text-ink transition-colors"
                >
                  Close
                </button>
              </div>
            ) : (
              <form onSubmit={submit} className="px-6 py-5 space-y-4">
                <p className="text-sm text-ink-muted leading-relaxed">
                  Spotted a wrong number, a missing provider, an outage, or
                  anything off about this benchmark? Tell us — it goes straight
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
                <div>
                  <label
                    htmlFor="report-contact"
                    className="block text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint mb-2"
                  >
                    Contact <span className="text-ink-faint">· optional</span>
                  </label>
                  <input
                    id="report-contact"
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                    type="text"
                    maxLength={200}
                    placeholder="email, telegram, github handle…"
                    className="w-full rounded border border-rule bg-paper-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-ink"
                  />
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
                    onClick={close}
                    className="text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
