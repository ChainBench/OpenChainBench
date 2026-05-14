"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";
import { citationQuote } from "@/lib/citation";

const ORIGIN = "https://openchainbench.com";

/**
 * Compact strip of citation affordances rendered under the bench title.
 *
 * - "Copy quote" — drops a journalist-ready attribution sentence into the
 *   clipboard, e.g. *"Mobula leads head lag at 32 ms (p50, 24h) — OpenChainBench (https://...)"*
 * - "Copy API URL" — copies the JSON endpoint so devs/agents can hook in.
 * - "Open API ↗" — opens the same URL in a new tab for inspection.
 *
 * Designed to be fast and unobtrusive. The fancy PNG / chart export lives
 * in <ShareSection> next to this; here we only ship the *quotable* atoms.
 */
export function CitationBar({ benchmark }: { benchmark: Benchmark }) {
  const apiUrl = `${ORIGIN}/api/stat/${benchmark.slug}`;
  const quote = citationQuote(benchmark, ORIGIN);

  return (
    <div className="mt-4 inline-flex flex-wrap items-center gap-1.5">
      <CopyButton value={quote} label="Copy quote" hint="Paste-ready citation" />
      <CopyButton value={apiUrl} label="Copy API URL" hint="JSON endpoint" />
      <a
        href={apiUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 rounded-full border border-rule px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:bg-paper-soft transition-colors"
        title="Open the JSON in a new tab"
      >
        Open API
        <ExternalLink size={11} strokeWidth={2.2} />
      </a>
    </div>
  );
}

function CopyButton({
  value,
  label,
  hint,
}: {
  value: string;
  label: string;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={hint}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        } catch {
          // ignore — clipboard blocked (e.g. http context)
        }
      }}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
        copied
          ? "border-good/40 bg-good/10 text-good"
          : "border-rule text-ink-soft hover:bg-paper-soft"
      }`}
    >
      {copied ? (
        <>
          <Check size={11} strokeWidth={2.5} />
          Copied
        </>
      ) : (
        <>
          <Copy size={11} strokeWidth={2.2} />
          {label}
        </>
      )}
    </button>
  );
}
