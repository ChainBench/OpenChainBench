"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { SearchItem } from "@/lib/search/types";
import type { FeaturedLeadersBlob } from "@/lib/search-featured";

type Ctx = {
  open: () => void;
  close: () => void;
  isOpen: boolean;
  items: SearchItem[];
  /** Warmed featured + trending blob (cron-fed). `null` until the first
   *  fetch resolves; consumers should skeleton-out their cards. */
  featured: FeaturedLeadersBlob | null;
  /** Imperative prefetch trigger — wire to the trigger's onMouseEnter
   *  so the round-trip starts before the user even clicks. Idempotent. */
  prefetchFeatured: () => void;
};

const SearchCtx = createContext<Ctx | null>(null);

const SearchDialog = dynamic(() => import("@/components/search/search-dialog"), {
  ssr: false,
});

type ProviderProps = {
  items: SearchItem[];
  children: React.ReactNode;
};

export function SearchProvider({ items, children }: ProviderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [featured, setFeatured] = useState<FeaturedLeadersBlob | null>(null);
  // De-dupe in-flight + completed fetches: hover, mount effect, and
  // first dialog open shouldn't fire three parallel calls.
  const fetchRef = useRef<Promise<void> | null>(null);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  const prefetchFeatured = useCallback(() => {
    if (fetchRef.current) return;
    // Use the default cache mode so the browser honours the endpoint's
    // Cache-Control headers (s-maxage=60, swr=300) instead of pinning a
    // stale entry forever. The previous `force-cache` setting meant a
    // user who had the page open during a chain rebrand kept seeing
    // pre-rebrand leaders (e.g. "TON" instead of "Gram") until they
    // hard-refreshed, because force-cache always returns a cached entry
    // regardless of freshness.
    fetchRef.current = fetch("/api/search/featured")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        // Endpoint shape is { ok, source, ageMs, featured, trending }.
        // Tolerate missing fields so a partial blob never breaks the dialog.
        const featuredArr = Array.isArray(j.featured) ? j.featured : [];
        const trendingArr = Array.isArray(j.trending) ? j.trending : [];
        setFeatured({ featured: featuredArr, trending: trendingArr });
      })
      .catch(() => {
        // Silent fail — dialog falls back to the items-only render.
        // Allow a retry on the next prefetch call by clearing the ref.
        fetchRef.current = null;
      });
  }, []);

  // Idle prefetch at mount. Most users open the dialog seconds after
  // landing; firing the request immediately means the data is sitting in
  // memory by the time they hit Cmd+K. Edge cache (s-maxage=60) makes
  // this nearly free across the site.
  useEffect(() => {
    prefetchFeatured();
  }, [prefetchFeatured]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen((v) => !v);
        return;
      }
      if (e.key === "/" && !isOpen) {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        const editable = t?.isContentEditable;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || editable) return;
        e.preventDefault();
        setIsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  const value = useMemo<Ctx>(
    () => ({ open, close, isOpen, items, featured, prefetchFeatured }),
    [open, close, isOpen, items, featured, prefetchFeatured],
  );

  return (
    <SearchCtx.Provider value={value}>
      {children}
      {isOpen && <SearchDialog />}
    </SearchCtx.Provider>
  );
}

export function useSearch(): Ctx {
  const ctx = useContext(SearchCtx);
  if (!ctx) {
    return {
      open: () => {},
      close: () => {},
      isOpen: false,
      items: [],
      featured: null,
      prefetchFeatured: () => {},
    };
  }
  return ctx;
}
