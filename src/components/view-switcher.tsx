"use client";

import {
  BarChart3,
  Check,
  ChevronDown,
  CircleDashed,
  LineChart,
  SlidersHorizontal,
} from "lucide-react";
import {
  type ComponentType,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { ViewType } from "@/lib/views";

const META: Record<
  ViewType,
  { icon: ComponentType<{ size?: number; strokeWidth?: number }>; label: string }
> = {
  timeseries: { icon: LineChart, label: "Time series" },
  rankedBar: { icon: BarChart3, label: "Ranked bar" },
  distribution: { icon: SlidersHorizontal, label: "Distribution" },
  donut: { icon: CircleDashed, label: "Donut" },
};

/**
 * Compact view switcher. A single trigger button shows the active view's
 * icon + chevron; clicking opens a small popover with every allowed view
 * as a row. Trades the always-visible segmented control for a one-icon
 * footprint so the chart card header doesn't feel like a toolbar.
 *
 * Hides itself when only one view is valid so single-option benches
 * keep their card header clean.
 */
export function ViewSwitcher({
  allowed,
  value,
  onChange,
  direction = "down",
}: {
  allowed: ViewType[];
  value: ViewType;
  onChange: (next: ViewType) => void;
  /** Where the popover opens relative to the trigger. Pass "up" when the
   *  switcher lives at the bottom of a card so the menu doesn't get
   *  clipped under the next section. */
  direction?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  // Close on outside click + Esc. Keeping the listener attached only
  // while open avoids holding a document-level handler permanently.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (allowed.length <= 1) return null;

  const ActiveIcon = META[value].icon;
  const popoverPosition =
    direction === "up" ? "bottom-full mb-1" : "top-full mt-1";

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        title={`View: ${META[value].label}`}
        aria-label={`Change chart view, currently ${META[value].label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-rule bg-surface text-ink-muted hover:text-ink hover:bg-paper-soft transition-colors"
      >
        <ActiveIcon size={14} strokeWidth={2} />
        <ChevronDown size={11} strokeWidth={2.5} />
      </button>
      {open && (
        <div
          id={popoverId}
          role="menu"
          className={`absolute right-0 ${popoverPosition} z-20 min-w-[170px] rounded-md border border-rule bg-surface shadow-lg overflow-hidden`}
        >
          {allowed.map((v) => {
            const { icon: Icon, label } = META[v];
            const isActive = v === value;
            return (
              <button
                key={v}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => {
                  onChange(v);
                  setOpen(false);
                }}
                className={`flex items-center gap-2 w-full px-3 py-2 text-left text-[12px] transition-colors ${
                  isActive
                    ? "bg-accent-soft text-accent"
                    : "text-ink-muted hover:text-ink hover:bg-paper-soft"
                }`}
              >
                <Icon size={13} strokeWidth={2} />
                <span className="flex-1">{label}</span>
                {isActive && <Check size={12} strokeWidth={2.5} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
