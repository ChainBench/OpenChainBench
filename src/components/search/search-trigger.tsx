"use client";

import { Search } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useSearch } from "@/components/search/search-provider";

const emptySubscribe = () => () => {};

function readIsMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(p);
}

type Props = {
  /**
   * - `desktop`: inline pill-ish button next to "GitHub" / theme toggle
   *   in the desktop nav. Hidden below md.
   * - `mobile`: 44×44 icon-only square sized to the same min-tap target
   *   as the hamburger. Hidden at md+.
   */
  variant: "desktop" | "mobile";
};

export function SearchTrigger({ variant }: Props) {
  const { open } = useSearch();
  // Read once on the client. SSR snapshot is `false` so we render the
  // Ctrl variant; the client snapshot replaces it on hydration if the
  // platform actually is macOS. Avoids the set-state-in-effect lint
  // and stays consistent with how ThemeToggle reads the DOM.
  const isMac = useSyncExternalStore(emptySubscribe, readIsMac, () => false);

  if (variant === "mobile") {
    return (
      <button
        type="button"
        onClick={open}
        aria-label="Open search"
        className="md:hidden inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded text-ink-muted hover:text-ink transition-colors"
      >
        <Search size={20} aria-hidden />
      </button>
    );
  }

  const shortcut = isMac ? "⌘K" : "Ctrl K";
  return (
    <button
      type="button"
      onClick={open}
      aria-label="Open search"
      className="inline-flex items-center gap-1.5 text-ink-muted hover:text-ink transition-colors"
    >
      <Search size={15} aria-hidden />
      <span>Search</span>
      <span className="ml-1 inline-flex items-center rounded border border-rule px-1 py-[1px] text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint tabular">
        {shortcut}
      </span>
    </button>
  );
}
