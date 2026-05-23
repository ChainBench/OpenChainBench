"use client";

import { BarChart3, LineChart, Trophy } from "lucide-react";
import type { ComponentType } from "react";
import type { ViewType } from "@/lib/views";

const META: Record<ViewType, { icon: ComponentType<{ size?: number; strokeWidth?: number }>; label: string }> = {
  timeseries: { icon: LineChart, label: "Time series" },
  rankedBar: { icon: BarChart3, label: "Ranked bar" },
  countLeaderboard: { icon: Trophy, label: "Leaderboard" },
};

/**
 * Segmented icon-only control for swapping the bench chart between
 * visualisations. Hides itself when only one view is available so a
 * 1-option control doesn't add visual noise on benches where there's
 * nothing to pick from.
 *
 * Read-only viewer pattern: 2-3 icons, tooltip on each, no chevron, no
 * dropdown. Matches the convention used by Vercel / Datadog / Grafana
 * viewer mode for chart-type switching. Skipped: keyboard shortcuts,
 * scroll-wheel cycling - both surprise viewers and don't fit a public
 * dashboard's discoverability model.
 */
export function ViewSwitcher({
  allowed,
  value,
  onChange,
}: {
  allowed: ViewType[];
  value: ViewType;
  onChange: (next: ViewType) => void;
}) {
  if (allowed.length <= 1) return null;
  return (
    <div
      role="group"
      aria-label="Chart view"
      className="inline-flex items-center rounded-md border border-rule p-0.5 bg-surface shrink-0"
    >
      {allowed.map((v) => {
        const { icon: Icon, label } = META[v];
        const isActive = v === value;
        return (
          <button
            key={v}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={isActive}
            onClick={() => onChange(v)}
            className={`inline-flex items-center justify-center w-7 h-7 rounded transition-colors ${
              isActive
                ? "bg-accent-soft text-accent border border-accent/30"
                : "text-ink-muted hover:text-ink hover:bg-paper-soft"
            }`}
          >
            <Icon size={14} strokeWidth={2} />
          </button>
        );
      })}
    </div>
  );
}
