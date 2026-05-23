"use client";

import { useEffect, useState } from "react";
import type { ViewType } from "@/lib/views";

const STORAGE_KEY_PREFIX = "ocb:view:";

/**
 * Per-bench chart-view preference, persisted in localStorage. Initial
 * render uses the server-derived default (so the prerendered HTML stays
 * cacheable - see export const dynamic = "force-static" on the bench
 * page). After hydration we read localStorage and switch if the user
 * has a saved preference compatible with the bench's allowed set.
 *
 * If the saved value is no longer valid (e.g. the bench changed unit,
 * or the view was removed from the codebase) we silently fall back to
 * the default and let the next setter rewrite the key.
 */
export function useViewPreference(
  benchmarkSlug: string,
  defaultView: ViewType,
  allowed: ViewType[],
): [ViewType, (next: ViewType) => void] {
  const [view, setView] = useState<ViewType>(defaultView);

  useEffect(() => {
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

  return [view, update];
}
