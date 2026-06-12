"use client";

import { useState, useSyncExternalStore } from "react";
import type { ViewType } from "@/lib/views";

const STORAGE_KEY_PREFIX = "ocb:view:";

const emptySubscribe = () => () => {};

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
 * reaches the screen.
 *
 * The stored value is read through useSyncExternalStore so the server
 * snapshot (null) and the client snapshot (the saved view) resolve in
 * the same post-hydration render as `mounted` - no setState-in-effect,
 * no extra cascading render.
 */
export function useViewPreference(
  benchmarkSlug: string,
  defaultView: ViewType,
  allowed: ViewType[],
): [ViewType, (next: ViewType) => void, boolean] {
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const stored = useSyncExternalStore(
    emptySubscribe,
    () => {
      try {
        return window.localStorage.getItem(STORAGE_KEY_PREFIX + benchmarkSlug);
      } catch {
        // localStorage can throw in private-mode safari + sandboxed iframes.
        // Silent fallback to the default render is the right call here.
        return null;
      }
    },
    () => null,
  );
  // Explicit in-session choice. Keyed by slug so navigating to another
  // bench falls back to that bench's stored/default view.
  const [override, setOverride] = useState<{ slug: string; view: ViewType } | null>(null);

  const storedView =
    stored && (allowed as string[]).includes(stored) ? (stored as ViewType) : null;
  const view =
    override && override.slug === benchmarkSlug
      ? override.view
      : storedView ?? defaultView;

  const update = (next: ViewType) => {
    setOverride({ slug: benchmarkSlug, view: next });
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
