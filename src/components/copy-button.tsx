"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Inline "Copy to clipboard" button. Toggles to "Copied" for 1.5 s after
 * a successful write. Shared by the contribute / mcp / docs pages so every
 * copy-able snippet on the site looks identical.
 */
export function CopyButton({
  value,
  label,
  mono,
}: {
  value: string;
  label: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={`inline-flex items-center gap-2 border border-ink/70 hover:bg-ink hover:text-paper transition-colors px-3 py-1.5 ${
        mono ? "font-mono text-[11px]" : "font-mono text-[11px] uppercase tracking-[0.16em]"
      }`}
    >
      {copied ? (
        <>
          <Check size={12} strokeWidth={2.5} />
          Copied
        </>
      ) : (
        <>
          <Copy size={12} strokeWidth={2} />
          {label}
        </>
      )}
    </button>
  );
}
