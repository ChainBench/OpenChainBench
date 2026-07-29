"use client";

import { useState } from "react";
import { DataApiBenchGroups } from "@/components/data-api-bench-groups";
import { DataApiProvidersPivot } from "@/components/data-api-providers-pivot";
import type { DataApiSnapshot } from "@/lib/data-api-stats";

type Tab = "benchmarks" | "providers";

export function DataApiHubTabs({ snapshot }: { snapshot: DataApiSnapshot }) {
  const [tab, setTab] = useState<Tab>("benchmarks");

  return (
    <>
      <div
        className="inline-flex rounded-lg border border-ink/15 p-1 bg-paper-soft/40 mb-6"
        role="tablist"
        aria-label="Data API benchmarks view"
      >
        <TabButton
          active={tab === "benchmarks"}
          onClick={() => setTab("benchmarks")}
          count={snapshot.totals.benchCount}
        >
          By benchmark
        </TabButton>
        <TabButton
          active={tab === "providers"}
          onClick={() => setTab("providers")}
          count={snapshot.totals.uniqueProviders}
        >
          By provider
        </TabButton>
      </div>

      {tab === "benchmarks" && (
        <DataApiBenchGroups groups={snapshot.groups} />
      )}
      {tab === "providers" && (
        <DataApiProvidersPivot
          rows={snapshot.providers}
          groupCount={snapshot.totals.groupCount}
        />
      )}
    </>
  );
}

function TabButton({
  children,
  active,
  count,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-colors flex items-center gap-2 ${
        active ? "bg-paper text-ink shadow-sm" : "text-ink-soft hover:text-ink"
      }`}
    >
      {children}
      <span
        className="text-[10.5px] text-ink-faint"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {count}
      </span>
    </button>
  );
}
