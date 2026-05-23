"use client";

import { useEffect, useState } from "react";
import type { ViewType } from "@/lib/views";

const STORAGE_KEY_PREFIX = "ocb:view:";

/**
 * Per-bench chart-view preference, persisted in localStorage.
 *
 * Returns `[view, setView, mounted]`. The mounted flag is the
 * hydration-flicker fix: the SSR HTML renders with the server default,
 * the client then reads localStorage and may swap to a saved view that
 * differs from the default - users were reporting "two charts visible
 * before settling on one" because the swap repainted the chart in a
 * visible second frame.
 *
 * Callers fade the chart in with `opacity: mounted ? 1 : 0` so the
 * default-view paint is invisible and only the resolved view ever
 * reaches the screen. Adds ~100 ms of empty card on first paint, in
 * exchange for zero flicker on every subsequent paint.
 */
export function useViewPreference(
  benchmarkSlug: string,
  defaultView: ViewType,
  allowed: ViewType[],
): [ViewType, (next: ViewType) => void, boolean] {
  const [view, setView] = useState<ViewType>(defaultView);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY_PREFIX + benchmarkSlug);
      if (stored && (allowed as string[]).includes(stored)) {
        setView(stored as ViewType);
      }
    } catch {
      // localStorage can throw in private-mode safari + sandboxed iframes.
      // Silent fallback to the default render is the right call here.
    }
    // We deliberately depend on slug only - re-running the read when the
    // allowed array reference changes would briefly flip a valid prior
    // choice back to default and then back again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [benchmarkSlug]);

  const update = (next: ViewType) => {
    setView(next);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY_PREFIX + benchmarkSlug, next);
    } catch {
      // Storage quota / private mode: the choice still applies for the
      // current session via state, just isn't remembered next visit.
    }
  };

  return [view, update, mounted];
}
