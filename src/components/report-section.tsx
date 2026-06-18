"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle } from "lucide-react";

// Heavy modal (form, status state, fetch, extra icons) is code-split out
// of the eagerly-loaded bundle. The trigger ships only this file; the
// modal chunk lands on first open. `ssr: false` is fine: the modal has
// no SEO value (UX-only) and we save the SSR pass.
const ReportSectionModal = dynamic(() => import("./report-section-modal"), {
  ssr: false,
});

type Props = {
  slug: string;
};

/**
 * Discreet "Report a problem" trigger. The modal itself lives in
 * `report-section-modal.tsx` and is dynamically imported on first
 * open. Posts to /api/report which forwards to a Slack webhook
 * server-side - the URL never reaches the client.
 */
export function ReportSection({ slug }: Props) {
  const [open, setOpen] = useState(false);

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

      {open && <ReportSectionModal slug={slug} onClose={() => setOpen(false)} />}
    </>
  );
}
