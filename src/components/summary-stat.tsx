"use client";

import type { ReactNode } from "react";

/** Mono uppercase section label rendered above tables and charts. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
      {children}
    </p>
  );
}

/** Thin key-value pair used in the summary strip above the chart on
 * bench detail and alternative pages. Replaces the boxed BigNumber
 * grid that read SaaS-dashboard. */
export function SummaryStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex-1 min-w-0 sm:min-w-[8rem] flex flex-col gap-1.5 px-5 py-4 sm:px-6 sm:py-5">
      <dt className="label-mono text-ink-faint">
        {label}
      </dt>
      <dd className="font-sans tabular text-lg sm:text-xl text-ink leading-none">
        {value}
        {hint ? (
          <span className="ml-1.5 text-ink-muted text-xs font-normal">{hint}</span>
        ) : null}
      </dd>
    </div>
  );
}
