"use client";

import { useState } from "react";

/**
 * Pill toggle that swaps between pre-rendered KPI domain sections on
 * /products/<slug> without navigation (perp venue, PM venue, PM data
 * feed, Hyperliquid builder, RPC provider). The sections are server
 * components rendered by the page and passed in as ReactNode content,
 * so switching tabs costs zero network round trips.
 *
 * With a single section the content renders directly (a one-button
 * toggle bar would be noise); with none, nothing. Inactive sections
 * stay in the DOM under `hidden` so tab switches are instant and
 * anchors keep working.
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

  if (sections.length === 0) return null;
  if (sections.length === 1) return <>{sections[0].content}</>;

  return (
    <div className="mt-10">
      <div
        className="inline-flex rounded-lg border border-ink/15 p-1 bg-paper-soft/40"
        role="tablist"
        aria-label="KPI domains"
      >
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={active === s.id}
            onClick={() => setActive(s.id)}
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
        <div key={s.id} hidden={active !== s.id}>
          {s.content}
        </div>
      ))}
    </div>
  );
}
