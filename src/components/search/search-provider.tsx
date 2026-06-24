"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { SearchItem } from "@/lib/search/types";

type Ctx = {
  open: () => void;
};

const SearchCtx = createContext<Ctx | null>(null);

/**
 * Lazy-load the dialog (and with it, cmdk + Fuse.js) on the first open.
 * Keeps the dialog out of the initial JS payload so the header trigger
 * is cheap to ship sitewide.
 */
const SearchDialog = dynamic(() => import("@/components/search/search-dialog"), {
  ssr: false,
});

type ProviderProps = {
  items: SearchItem[];
  children: React.ReactNode;
};

export function SearchProvider({ items, children }: ProviderProps) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  // Global keyboard shortcuts. Cmd+K (mac) / Ctrl+K (win/linux) toggle
  // the dialog. `/` opens it the way GitHub does — but only when the
  // active element is not already an input, so typing `/` in a search
  // box on a bench page doesn't fire twice.
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

  const value = useMemo<Ctx>(() => ({ open }), [open]);

  return (
    <SearchCtx.Provider value={value}>
      {children}
      {isOpen && <SearchDialog items={items} onClose={close} />}
    </SearchCtx.Provider>
  );
}

export function useSearch(): Ctx {
  const ctx = useContext(SearchCtx);
  if (!ctx) {
    // Soft fallback: when something tries to open the dialog outside
    // the provider (shouldn't happen, but cheap to guard) we make the
    // trigger inert rather than crash the page.
    return { open: () => {} };
  }
  return ctx;
}
