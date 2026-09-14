"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { SearchItem } from "@/lib/search/types";
import type { FeaturedLeadersBlob } from "@/lib/search-featured";

type Ctx = {
  open: () => void;
  close: () => void;
  isOpen: boolean;
  /** Search corpus. Empty until `/api/search/index` resolves; the
   *  dialog shows a loading state while `indexStatus` is "loading". */
  items: SearchItem[];
  indexStatus: "idle" | "loading" | "ready" | "error";
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
  children: React.ReactNode;
};

export function SearchProvider({ children }: ProviderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [featured, setFeatured] = useState<FeaturedLeadersBlob | null>(null);
  // The corpus is NOT shipped with the page anymore (it was 278 KB of
  // every HTML response, see /api/search/index). It is fetched once,
  // on the first hover / focus / open, and kept for the session.
  const [items, setItems] = useState<SearchItem[]>([]);
  const [indexStatus, setIndexStatus] = useState<Ctx["indexStatus"]>("idle");
  const indexRef = useRef<Promise<void> | null>(null);
  // De-dupe in-flight + completed fetches: hover, mount effect, and
  // first dialog open shouldn't fire three parallel calls.
  const fetchRef = useRef<Promise<void> | null>(null);

  const loadIndex = useCallback(() => {
    if (indexRef.current) return;
    setIndexStatus("loading");
    indexRef.current = fetch("/api/search/index")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const arr = Array.isArray(j?.items) ? (j.items as SearchItem[]) : null;
        if (!arr) throw new Error("bad index payload");
        setItems(arr);
        setIndexStatus("ready");
      })
      .catch(() => {
        // Let the next hover / open retry.
        indexRef.current = null;
        setIndexStatus("error");
      });
  }, []);

  const open = useCallback(() => {
    loadIndex();
    setIsOpen(true);
  }, [loadIndex]);
  const close = useCallback(() => setIsOpen(false), []);

  const prefetchFeatured = useCallback(() => {
    // Hover / focus on the trigger is the earliest intent signal we
    // get; start the corpus download alongside the featured blob.
    loadIndex();
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

  // No prefetch at mount anymore: a fetch per page view is exactly the
  // per-request transfer this change removes. Hover, focus, Cmd+K and
  // "/" all trigger the load, and the CDN serves it in well under the
  // time it takes the dialog to animate in.

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        loadIndex();
        setIsOpen((v) => !v);
        return;
      }
      if (e.key === "/" && !isOpen) {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        const editable = t?.isContentEditable;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || editable) return;
        e.preventDefault();
        loadIndex();
        setIsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, loadIndex]);

  const value = useMemo<Ctx>(
    () => ({ open, close, isOpen, items, indexStatus, featured, prefetchFeatured }),
    [open, close, isOpen, items, indexStatus, featured, prefetchFeatured],
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
      indexStatus: "idle",
      featured: null,
      prefetchFeatured: () => {},
    };
  }
  return ctx;
}
