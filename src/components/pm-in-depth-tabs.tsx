"use client";

import { useState, type ReactNode } from "react";

/**
 * Tab picker for the per-venue / per-feed deep-dive sections under the
 * /prediction-markets hub. The page renders every section server side
 * (SEO needs them in the DOM and the bench rows come from server data),
 * then we hide all but the active one client side.
 *
 * Using the `hidden` attribute instead of conditional rendering keeps
 * the SSR markup intact: crawlers and the no-JS path still see every
 * section, and switching tabs costs zero network round trips.
 */

export type PmInDepthTab = {
  slug: string;
  label: string;
};

export function PmInDepthTabs({
  ariaLabel,
  tabs,
  panels,
  defaultSlug,
}: {
  ariaLabel: string;
  tabs: PmInDepthTab[];
  panels: ReactNode[];
  defaultSlug?: string;
}) {
  const [active, setActive] = useState<string>(defaultSlug ?? tabs[0]?.slug ?? "");

  if (tabs.length === 0) return null;

  return (
    <>
      <div
        className="flex flex-wrap gap-1 rounded-lg border border-ink/15 p-1 bg-paper-soft/40 mb-4"
        role="tablist"
        aria-label={ariaLabel}
      >
        {tabs.map((t) => {
          const isActive = t.slug === active;
          return (
            <button
              key={t.slug}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`pm-indepth-${t.slug}`}
              onClick={() => setActive(t.slug)}
              className={`px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
                isActive
                  ? "bg-paper text-ink shadow-sm"
                  : "text-ink-soft hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tabs.map((t, i) => (
        <div
          key={t.slug}
          id={`pm-indepth-${t.slug}`}
          role="tabpanel"
          aria-labelledby={`pm-indepth-tab-${t.slug}`}
          hidden={t.slug !== active}
        >
          {panels[i]}
        </div>
      ))}
    </>
  );
}
