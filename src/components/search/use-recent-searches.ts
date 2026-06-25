"use client";

import { useSyncExternalStore, useCallback } from "react";
import type { SearchKind } from "@/lib/search/types";

const KEY = "ocb:search:recent:v1";
const MAX_RECENT = 7;
const CHANGE_EVENT = "ocb:search:recent:changed";

export type RecentEntry = {
  id: string;
  title: string;
  url: string;
  kind: SearchKind;
  /** Optional slug for logo resolution (provider/chain only). */
  slug?: string;
};

function readStorage(): RecentEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_RECENT) as RecentEntry[];
  } catch {
    return [];
  }
}

function writeStorage(entries: RecentEntry[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries));
    // Same-tab notify. The native `storage` event only fires on OTHER
    // tabs, so without this the dialog wouldn't see its own writes
    // unless remounted.
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // private-mode Safari, sandboxed iframes, etc. — fail silently.
  }
}

function subscribe(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const handler = () => cb();
  window.addEventListener("storage", handler);
  window.addEventListener(CHANGE_EVENT, handler);
  return () => {
    window.removeEventListener("storage", handler);
    window.removeEventListener(CHANGE_EVENT, handler);
  };
}

// useSyncExternalStore expects snapshot stability between renders that
// share the same underlying data, otherwise React falls into a render
// loop. Stable cache keyed by the raw JSON string so a fresh read of
// the same payload returns the same array reference.
let cachedJson = "";
let cachedSnapshot: RecentEntry[] = [];
function getSnapshot(): RecentEntry[] {
  const raw = (typeof window !== "undefined" && window.localStorage.getItem(KEY)) || "[]";
  if (raw === cachedJson) return cachedSnapshot;
  cachedJson = raw;
  cachedSnapshot = readStorage();
  return cachedSnapshot;
}

const SERVER_SNAPSHOT: RecentEntry[] = [];
const getServerSnapshot = () => SERVER_SNAPSHOT;

export function useRecentSearches() {
  const recent = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const push = useCallback((entry: RecentEntry) => {
    const current = readStorage();
    const next = [entry, ...current.filter((e) => e.id !== entry.id)].slice(0, MAX_RECENT);
    writeStorage(next);
  }, []);

  const remove = useCallback((id: string) => {
    const current = readStorage();
    writeStorage(current.filter((e) => e.id !== id));
  }, []);

  const clear = useCallback(() => {
    writeStorage([]);
  }, []);

  return { recent, push, remove, clear };
}
