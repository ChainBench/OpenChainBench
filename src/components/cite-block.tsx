"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import type { CiteBundle } from "@/lib/citation";

type Format = "plain" | "bibtex" | "apa";

const TABS: { id: Format; label: string }[] = [
  { id: "plain", label: "Plain" },
  { id: "bibtex", label: "BibTeX" },
  { id: "apa", label: "APA" },
];

/**
 * Citation block rendered on every bench page. Pre-computed strings
 * arrive from the server (see `citeBundle` in @/lib/citation) so the
 * three formats land in the initial HTML — Google and LLM crawlers
 * read the canonical URL before any JS hydrates. Tabs only swap which
 * pane is visible client-side.
 *
 * Mirrors the wording exposed by /api/citable and /api/stat/<slug> so
 * an external paste from either surface lines up character-for-character
 * with what a journalist copies from this UI.
 */
export function CiteBlock({ cite }: { cite: CiteBundle }) {
  const [active, setActive] = useState<Format>("plain");

  return (
    <section
      aria-label="Cite this benchmark"
      className="mt-8 max-w-3xl card-soft rounded-xl px-4 sm:px-5 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="label-mono text-ink-faint">Cite this benchmark</p>
        <div className="flex flex-wrap items-center gap-1">
          {TABS.map((t) => {
            const isActive = active === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActive(t.id)}
                aria-pressed={isActive}
                className={[
                  "rounded px-2.5 py-1 text-[11px] font-sans tabular uppercase tracking-[0.1em] font-medium transition-colors",
                  isActive
                    ? "bg-ink text-paper"
                    : "text-ink-muted hover:text-ink hover:bg-paper-soft",
                ].join(" ")}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {TABS.map((t) => {
        const value = cite[t.id];
        const hidden = active !== t.id;
        return (
          <div
            key={t.id}
            hidden={hidden}
            className="mt-3 flex flex-col gap-3"
          >
            <pre className="m-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded bg-paper-soft px-3 py-2 text-[12px] leading-relaxed font-mono text-ink">
              {value}
            </pre>
            <div className="flex">
              <CopyButton value={value} label={`Copy ${t.label}`} mono />
            </div>
          </div>
        );
      })}
    </section>
  );
}
