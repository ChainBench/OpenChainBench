"use client";

import { Search } from "lucide-react";
import { useSearch } from "@/components/search/search-provider";

type Props = {
  /**
   * - `desktop`: wide input-style pill shown in the desktop nav. Reads
   *   visually as a real search field (light surface, rounded, full
   *   width within its container) so users discover the feature without
   *   needing the keyboard shortcut.
   * - `mobile`: 44×44 icon-only square sized to the same min-tap target
   *   as the hamburger. Hidden at md+.
   */
  variant: "desktop" | "mobile";
};

export function SearchTrigger({ variant }: Props) {
  const { open } = useSearch();

  if (variant === "mobile") {
    return (
      <button
        type="button"
        onClick={open}
        aria-label="Open search"
        className="md:hidden inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md text-ink-muted hover:text-ink transition-colors"
      >
        <Search size={20} aria-hidden />
      </button>
    );
  }

  // Input-look trigger. Soft surface + rule border so the affordance
  // reads as a text field even though it actually opens the cmdk modal.
  // No platform-specific shortcut hint: ⌘K is wrong on Windows/Linux,
  // Ctrl K is wrong on Mac, and a dynamic swap creates hydration
  // flicker for two-character gain. Shortcut still works, just not
  // advertised in the chrome.
  return (
    <button
      type="button"
      onClick={open}
      aria-label="Open search"
      className="group inline-flex items-center gap-2 w-full max-w-[440px] h-9 px-3 rounded-md border border-rule bg-paper-soft text-left text-sm text-ink-faint hover:border-rule-strong hover:text-ink-muted hover:bg-paper transition-colors"
    >
      <Search size={15} aria-hidden className="shrink-0" />
      <span className="truncate">Search benchmarks, products…</span>
    </button>
  );
}
