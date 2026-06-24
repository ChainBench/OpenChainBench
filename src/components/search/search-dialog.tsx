"use client";

import { Command } from "cmdk";
import Fuse from "fuse.js";
import { Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchItem, SearchKind } from "@/lib/search/types";

type Props = {
  items: SearchItem[];
  onClose: () => void;
};

const KIND_ORDER: SearchKind[] = [
  "Benchmark",
  "Product",
  "Compare",
  "Alternative",
  "Answer",
  "Chain",
  "Page",
];

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

export default function SearchDialog({ items, onClose }: Props) {
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
    return fuse.search(q, { limit: 8 }).map((r) => r.item);
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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 backdrop-blur-sm p-4 sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Search"
    >
      <div
        className="relative w-full max-w-xl mx-auto mt-[10vh] rounded-md border border-rule bg-paper shadow-2xl font-sans"
        onClick={(e) => e.stopPropagation()}
      >
        <Command
          label="Site search"
          shouldFilter={false}
          className="flex flex-col"
        >
          <div className="flex items-center gap-2.5 border-b border-rule px-4 py-3">
            <Search size={15} className="text-ink-faint shrink-0" aria-hidden />
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder="Search benchmarks, products, chains, answers…"
              className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint outline-none border-0"
            />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close search"
              className="text-ink-muted hover:text-ink transition-colors"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>

          <Command.List className="max-h-[60vh] overflow-y-auto py-2">
            {headerLabel && (
              <div className="px-4 pt-1 pb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-faint">
                {headerLabel}
              </div>
            )}

            {showEmpty && (
              <Command.Empty className="px-4 py-6 text-sm text-ink-muted leading-relaxed">
                No results for &quot;{trimmed}&quot;. Try searching by bench name,
                provider, chain, or keyword.
              </Command.Empty>
            )}

            {grouped.map(({ kind, list }) => (
              <Command.Group
                key={kind}
                heading={trimmed.length > 0 ? kind : undefined}
                className="px-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.18em] [&_[cmdk-group-heading]]:text-ink-faint"
              >
                {list.map((it) => (
                  <Command.Item
                    key={it.id}
                    value={`${it.kind}|${it.title}|${it.id}`}
                    onSelect={() => go(it.url)}
                    className="flex items-start gap-3 rounded px-2 py-2 cursor-pointer text-sm aria-selected:bg-paper-soft"
                  >
                    <span className="mt-[3px] inline-flex items-center justify-center min-w-[64px] shrink-0 rounded border border-rule px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                      {it.kind}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-ink truncate">
                        {it.title}
                      </span>
                      {it.description && (
                        <span className="block text-xs text-ink-muted truncate">
                          {it.description}
                        </span>
                      )}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>

          <div className="flex items-center justify-between border-t border-rule px-4 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
            <span>Enter to go</span>
            <span>Esc to close</span>
          </div>
        </Command>
      </div>
    </div>
  );
}
