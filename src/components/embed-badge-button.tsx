"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Code2, Loader2, X } from "lucide-react";
import { CopyButton } from "@/components/copy-button";

type Format = "html" | "markdown" | "json";

const FORMATS: { id: Format; label: string }[] = [
  { id: "html", label: "HTML" },
  { id: "markdown", label: "Markdown" },
  { id: "json", label: "JSON" },
];

type Props = {
  benchSlug: string;
  benchTitle: string;
  providerSlug: string;
  providerName: string;
  /** Optional bench scope. Mirrors what the bench page filters by, so
   *  the embedded badge SVG and snippet stay aligned with the row the
   *  reader is looking at. */
  chain?: string | null;
  region?: string | null;
  kind?: string | null;
};

/**
 * Per-row "Embed" CTA. Opens a popover with three copy-paste snippet
 * blocks (HTML, Markdown, JSON) and a live SVG preview of the badge for
 * that (bench, provider, scope) triple.
 *
 * The snippet payloads come from the existing
 *   GET /api/badge/<bench>/<provider>/snippet?format=...
 * endpoint — no new route, no new shape. Two fetches on first open
 * (html + markdown text payloads; the JSON payload also gives us the
 * badge URL for the preview <img>). Refetched when the scope changes.
 */
export function EmbedBadgeButton({
  benchSlug,
  benchTitle,
  providerSlug,
  providerName,
  chain = null,
  region = null,
  kind = null,
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<Format>("html");
  const [snippets, setSnippets] = useState<Record<Format, string> | null>(null);
  const [badgeUrl, setBadgeUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const scopeQs = useMemo(() => {
    const qs = new URLSearchParams();
    if (chain) qs.set("chain", chain);
    if (region) qs.set("region", region);
    if (kind) qs.set("kind", kind);
    const s = qs.toString();
    return s ? `&${s}` : "";
  }, [chain, region, kind]);

  // Reset cached snippet state during render whenever the identity of the
  // fetch (open + scope) changes, instead of dispatching setState inside
  // the effect body (which trips `react-hooks/set-state-in-effect`). The
  // adjacent useEffect below performs the actual fetch.
  const fetchKey = open ? `${benchSlug}|${providerSlug}|${scopeQs}` : "";
  const [prevFetchKey, setPrevFetchKey] = useState(fetchKey);
  if (prevFetchKey !== fetchKey) {
    setPrevFetchKey(fetchKey);
    setSnippets(null);
    setBadgeUrl(null);
    setError(false);
  }

  // Load snippets when the popover opens or scope changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const base = `/api/badge/${benchSlug}/${providerSlug}/snippet`;
    Promise.all([
      fetch(`${base}?format=json${scopeQs}`).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`json ${r.status}`)),
      ),
      fetch(`${base}?format=html${scopeQs}`).then((r) =>
        r.ok ? r.text() : Promise.reject(new Error(`html ${r.status}`)),
      ),
      fetch(`${base}?format=markdown${scopeQs}`).then((r) =>
        r.ok ? r.text() : Promise.reject(new Error(`markdown ${r.status}`)),
      ),
    ])
      .then(([jsonPayload, html, markdown]) => {
        if (cancelled) return;
        setSnippets({
          html: html.trim(),
          markdown: markdown.trim(),
          json: JSON.stringify(jsonPayload, null, 2),
        });
        setBadgeUrl(
          typeof jsonPayload?.badge_url === "string"
            ? jsonPayload.badge_url
            : null,
        );
      })
      .catch((err) => {
        if (cancelled) return;
        if (process.env.NODE_ENV !== "production") {
          console.debug("[embed-badge] snippet fetch failed", err);
        }
        setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, benchSlug, providerSlug, scopeQs]);

  // Esc to close + body scroll lock + outside click + initial focus.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      } else if (e.key === "Tab" && dialogRef.current) {
        // Simple focus trap.
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], textarea, input, select, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);

    // Defer focus so the dialog has mounted.
    const focusTimer = window.setTimeout(() => {
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      focusables?.[0]?.focus();
    }, 0);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(focusTimer);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  const ariaLabel = `Embed badge for ${providerName} on ${benchTitle}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Embed badge"
        className="inline-flex items-center justify-center gap-1 shrink-0 rounded border border-rule px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-ink-muted hover:text-ink hover:border-ink transition-colors font-sans font-medium min-h-[24px]"
      >
        <Code2 size={11} strokeWidth={2} />
        <span className="hidden sm:inline">Embed</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 backdrop-blur-sm p-4 sm:p-8"
          onClick={() => setOpen(false)}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            className="card-soft relative w-full max-w-2xl rounded-md border border-rule bg-paper shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-rule px-4 sm:px-5 py-3">
              <div className="min-w-0">
                <p className="label-mono-xs text-ink-faint">Embed badge</p>
                <p className="mt-0.5 text-[13px] font-medium text-ink truncate">
                  {providerName} on {benchTitle}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="text-ink-muted hover:text-ink transition-colors shrink-0 ml-3"
              >
                <X size={18} strokeWidth={2} />
              </button>
            </div>

            <div className="px-4 sm:px-5 py-4 space-y-4">
              {/* Preview */}
              <div className="rounded border border-rule bg-paper-soft p-3 flex items-center justify-center min-h-[68px]">
                {badgeUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={badgeUrl}
                    alt={`Live badge for ${providerName} on ${benchTitle}`}
                    className="max-w-full h-auto"
                  />
                ) : error ? (
                  <span className="text-[11px] text-ink-muted">
                    Could not load the badge preview.
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2 text-[11px] text-ink-muted">
                    <Loader2 size={14} className="animate-spin" />
                    Loading badge…
                  </span>
                )}
              </div>

              {/* Format tabs */}
              <div
                role="tablist"
                aria-label="Snippet format"
                className="flex flex-wrap items-center gap-1 border border-rule rounded p-1 bg-paper-soft w-fit"
              >
                {FORMATS.map((f) => (
                  <button
                    key={f.id}
                    role="tab"
                    type="button"
                    aria-selected={active === f.id}
                    onClick={() => setActive(f.id)}
                    className={`label-mono-xs px-2.5 py-1 rounded transition-colors ${
                      active === f.id
                        ? "bg-paper text-ink shadow-sm"
                        : "text-ink-muted hover:text-ink"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {/* Active snippet */}
              <div className="space-y-2">
                <div className="relative">
                  <textarea
                    readOnly
                    value={
                      error
                        ? "Failed to load snippet."
                        : (snippets?.[active] ?? "Loading…")
                    }
                    rows={active === "json" ? 10 : 4}
                    aria-label={`${active.toUpperCase()} snippet`}
                    className="w-full font-mono text-[11px] bg-paper-soft border border-rule rounded p-3 pr-3 resize-none text-ink whitespace-pre overflow-x-auto"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </div>
                <div className="flex items-center justify-end">
                  <CopyButton
                    value={snippets?.[active] ?? ""}
                    label={`Copy ${active}`}
                  />
                </div>
              </div>

              <p className="text-[11px] text-ink-muted leading-relaxed border-t border-rule pt-3">
                Free to embed under CC-BY-4.0. Backlink to openchainbench.com
                requested.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
