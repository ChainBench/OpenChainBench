"use client";

import { Command } from "cmdk";
import Fuse from "fuse.js";
import { ArrowRight, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "@/components/search/search-provider";
import type { SearchItem, SearchKind } from "@/lib/search/types";

const KIND_ORDER: SearchKind[] = [
  "Benchmark",
  "Product",
  "Compare",
  "Alternative",
  "Answer",
  "Chain",
  "Page",
];

const KIND_LABEL: Record<SearchKind, string> = {
  Benchmark: "Benchmarks",
  Product: "Products",
  Compare: "Compare",
  Alternative: "Alternatives",
  Answer: "Answers",
  Chain: "Chains",
  Page: "Pages",
};

/**
 * Hardcoded "popular benches" shown when the query is empty. No
 * analytics involved, just an editorial pick of high-traffic specs
 * that map to known SEO winners. Update by hand when traffic shifts.
 */
const POPULAR_BENCH_SLUGS = [
  "pm-data-freshness",
  "aggregator-head-lag",
  "l1-finality",
  "rpc-capabilities",
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded border border-rule bg-paper-soft text-[10px] font-medium text-ink-muted font-mono">
      {children}
    </kbd>
  );
}

export default function SearchDialog() {
  const { items, close: onClose } = useSearch();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // One Fuse instance per dialog mount. The full corpus is ~400 docs
  // so build cost is sub-millisecond, no need to memoise across mounts.
  const fuse = useMemo(
    () =>
      new Fuse(items, {
        keys: [
          { name: "title", weight: 0.6 },
          { name: "tags", weight: 0.3 },
          { name: "description", weight: 0.1 },
        ],
        threshold: 0.35,
        minMatchCharLength: 2,
        ignoreLocation: true,
      }),
    [items],
  );

  // Body scroll lock + ESC handler, same pattern as report-section-modal.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    // cmdk autofocuses its own input, but giving the ref-driven focus
    // a tick of priority avoids a flash where typing the first letter
    // gets eaten by the trigger button's focus.
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);

  const results = useMemo<SearchItem[]>(() => {
    const q = query.trim();
    if (!q) {
      const popular = POPULAR_BENCH_SLUGS
        .map((slug) => items.find((it) => it.id === `bench:${slug}`))
        .filter((it): it is SearchItem => Boolean(it));
      return popular;
    }
    return fuse.search(q, { limit: 12 }).map((r) => r.item);
  }, [query, fuse, items]);

  const grouped = useMemo(() => {
    const map = new Map<SearchKind, SearchItem[]>();
    for (const it of results) {
      const list = map.get(it.kind) ?? [];
      list.push(it);
      map.set(it.kind, list);
    }
    return KIND_ORDER
      .map((kind) => ({ kind, list: map.get(kind) ?? [] }))
      .filter((g) => g.list.length > 0);
  }, [results]);

  function go(url: string) {
    onClose();
    router.push(url);
  }

  const trimmed = query.trim();
  const showEmpty = trimmed.length > 0 && results.length === 0;
  const headerLabel = trimmed.length === 0 ? "Popular benchmarks" : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/50 backdrop-blur-md p-4 sm:p-8 animate-in fade-in duration-150"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Search"
    >
      <div
        className="relative w-full max-w-2xl mx-auto mt-[8vh] rounded-xl border border-rule-strong/60 bg-surface shadow-[0_24px_60px_-12px_rgba(0,0,0,0.45)] font-sans overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Command
          label="Site search"
          shouldFilter={false}
          className="flex flex-col"
        >
          {/* Input row — no border on the input itself, focus ring removed,
              search icon left, ESC kbd right. */}
          <div className="flex items-center gap-3 px-5 h-14 border-b border-rule">
            <Search size={18} className="text-ink-faint shrink-0" aria-hidden />
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder="Search benchmarks, products, chains, answers…"
              className="flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-faint outline-none border-0 ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
            />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close search"
              className="hidden sm:inline-flex"
            >
              <Kbd>esc</Kbd>
            </button>
          </div>

          <Command.List className="max-h-[60vh] overflow-y-auto px-2 py-2">
            {headerLabel && (
              <div className="px-3 pt-3 pb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
                {headerLabel}
              </div>
            )}

            {showEmpty && (
              <Command.Empty className="px-4 py-10 text-center text-sm text-ink-muted leading-relaxed">
                No results for &ldquo;{trimmed}&rdquo;.
                <br />
                <span className="text-xs text-ink-faint">
                  Try a bench name, provider, or chain.
                </span>
              </Command.Empty>
            )}

            {grouped.map(({ kind, list }) => (
              <Command.Group
                key={kind}
                heading={trimmed.length > 0 ? KIND_LABEL[kind] : undefined}
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-ink-faint"
              >
                {list.map((it) => (
                  <Command.Item
                    key={it.id}
                    value={`${it.kind}|${it.title}|${it.id}`}
                    onSelect={() => go(it.url)}
                    className="group flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer text-sm aria-selected:bg-paper-soft transition-colors"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-ink-faint shrink-0">
                          {KIND_LABEL[it.kind].replace(/s$/, "")}
                        </span>
                        <span className="text-rule-strong">·</span>
                        <span className="font-medium text-ink truncate">
                          {it.title}
                        </span>
                      </span>
                      {it.description && (
                        <span className="block mt-0.5 text-[12px] text-ink-muted truncate">
                          {it.description}
                        </span>
                      )}
                    </span>
                    <ArrowRight
                      size={14}
                      className="text-ink-faint shrink-0 opacity-0 group-aria-selected:opacity-100 transition-opacity"
                      aria-hidden
                    />
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>

          {/* Footer — subtle separator, kbd-driven hints. */}
          <div className="flex items-center justify-between gap-4 border-t border-rule px-4 py-2.5 text-[11px] text-ink-faint">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                <span>navigate</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd>↵</Kbd>
                <span>open</span>
              </span>
            </div>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>esc</Kbd>
              <span>close</span>
            </span>
          </div>
        </Command>
      </div>
    </div>
  );
}
