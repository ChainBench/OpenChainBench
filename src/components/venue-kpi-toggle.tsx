"use client";

import { useEffect, useState } from "react";

/**
 * Pill toggle that swaps between pre-rendered KPI domain sections on
 * /products/<slug> without navigation (perp venue, PM venue, PM data
 * feed, Hyperliquid frontend, RPC provider). The sections are server
 * components rendered by the page and passed in as ReactNode content,
 * so switching tabs costs zero network round trips.
 *
 * The bar renders whenever at least one section exists, so a single
 * domain still shows its labeled pill: the label tells the reader which
 * KPI family they are looking at, and additional pills appear the day
 * the product gains data in another domain. Inactive sections stay in
 * the DOM under `hidden` so tab switches are instant and crawlers see
 * every view.
 *
 * Deep links: the URL hash selects the view (`/products/fomo#hl`), which
 * is what the retired /hyperliquid/<slug> and /perp/<slug> routes 308
 * to. Clicking a pill rewrites the hash with replaceState so the URL
 * stays shareable, without a navigation or a scroll jump.
 *
 * Pill styling mirrors PmHubTabs / PerpHubTabs.
 */

export type VenueToggleSection = {
  id: string;
  label: string;
  content: React.ReactNode;
};

export function VenueKpiToggle({
  sections,
}: {
  sections: VenueToggleSection[];
}) {
  const [active, setActive] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const fromHash = () => {
      const id = window.location.hash.replace(/^#/, "");
      if (id && sections.some((s) => s.id === id)) setActive(id);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [sections]);

  if (sections.length === 0) return null;

  const select = (id: string) => {
    setActive(id);
    try {
      window.history.replaceState(null, "", `#${id}`);
    } catch {
      /* history API unavailable: the tab still switches */
    }
  };

  return (
    <div className="mt-10">
      <div
        className="inline-flex flex-wrap rounded-lg border border-ink/15 p-1 bg-paper-soft/40"
        role="tablist"
        aria-label="Views"
      >
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={active === s.id}
            aria-controls={`view-${s.id}`}
            onClick={() => select(s.id)}
            className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
              active === s.id
                ? "bg-paper text-ink shadow-sm"
                : "text-ink-soft hover:text-ink"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {sections.map((s) => (
        <div key={s.id} id={`view-${s.id}`} role="tabpanel" hidden={active !== s.id}>
          {s.content}
        </div>
      ))}
    </div>
  );
}
