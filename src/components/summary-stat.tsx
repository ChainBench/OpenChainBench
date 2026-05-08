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
    <div className="flex items-baseline gap-2">
      <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint shrink-0">
        {label}
      </dt>
      <dd className="font-mono tabular text-sm text-ink leading-none">
        {value}
        {hint ? (
          <span className="ml-1.5 text-ink-muted text-xs font-normal">{hint}</span>
        ) : null}
      </dd>
    </div>
  );
}
