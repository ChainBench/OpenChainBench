"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";

const ORIGIN = "https://openchainbench.com";

/**
 * Single citation affordance rendered under the bench title: a "Copy API
 * URL" button that puts the JSON endpoint on the clipboard so devs and
 * agents can hook in without leaving the page. The page URL itself is
 * the human-readable citation anchor (right-click copy link).
 */
export function CitationBar({ benchmark }: { benchmark: Benchmark }) {
  const apiUrl = `${ORIGIN}/api/stat/${benchmark.slug}`;
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(apiUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard blocked in some contexts (http, sandboxed iframes); silent.
    }
  }

  return (
    <div className="mt-4 inline-flex">
      <button
        type="button"
        onClick={onCopy}
        title={apiUrl}
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
            Copy API URL
          </>
        )}
      </button>
    </div>
  );
}
