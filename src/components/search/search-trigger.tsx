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
  const { open, prefetchFeatured } = useSearch();

  // Hover/focus prefetch: kicks the /api/search/featured fetch as soon
  // as the user signals intent (mouse-over the trigger or tab-focus).
  // Combined with the SearchProvider's mount-time prefetch this means
  // the Live Leaders + Trending data is usually warm in memory by the
  // time the dialog mounts, so the skeleton state is invisible.
  // No-ops after the first call (de-duped in the provider).

  if (variant === "mobile") {
    return (
      <button
        type="button"
        onClick={open}
        onMouseEnter={prefetchFeatured}
        onFocus={prefetchFeatured}
        aria-label="Open search"
        className="md:hidden inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md text-ink-muted hover:text-ink transition-colors"
      >
        <Search size={20} aria-hidden />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      onMouseEnter={prefetchFeatured}
      onFocus={prefetchFeatured}
      aria-label="Open search"
      className="group inline-flex items-center gap-2 w-full max-w-[440px] h-9 px-3 rounded-md border border-rule bg-paper-soft text-left text-sm text-ink-faint hover:border-rule-strong hover:text-ink-muted hover:bg-paper transition-colors"
    >
      <Search size={15} aria-hidden className="shrink-0" />
      <span className="truncate">Search benchmarks, products…</span>
    </button>
  );
}
