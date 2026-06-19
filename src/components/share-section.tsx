"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Image as ImageIcon } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";

// Heavy modal (template tabs, provider pickers, SharePreview, fetch +
// download logic, extra icons) is code-split out of the eagerly-loaded
// bundle. The trigger ships only this file; the modal chunk lands on
// first open. `ssr: false` is fine: the modal has no SEO value (UX-only)
// and we save the SSR pass.
const ShareSectionModal = dynamic(() => import("./share-section-modal"), {
  ssr: false,
});

type Props = {
  slug: string;
  title: string;
  benchmark: Benchmark;
  /** When the bench page is filtered by chain, propagate it to the
   * share-card so the generated PNG renders with the same scope. */
  chain?: string | null;
};

/**
 * Discreet "Export as image" trigger. The modal itself lives in
 * `share-section-modal.tsx` and is dynamically imported on first
 * open so its template logic, provider pickers and preview image
 * stay out of the initial bundle.
 */
export function ShareSection({ slug, title, benchmark, chain }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Export image"
        title="Export image"
        className="inline-flex items-center justify-center rounded-md border border-ink bg-ink p-2.5 text-paper hover:bg-paper hover:text-ink transition-colors shadow-sm"
      >
        <ImageIcon size={14} strokeWidth={2} />
      </button>

      {open && (
        <ShareSectionModal
          slug={slug}
          title={title}
          benchmark={benchmark}
          chain={chain}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
