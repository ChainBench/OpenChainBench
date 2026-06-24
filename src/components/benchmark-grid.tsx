"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { LayoutGrid, List, Search } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";
import { BenchmarkCard } from "@/components/benchmark-card";
import { categorySlugFromLabel } from "@/lib/categories";

/**
 * Client-side filter/search shell for the All Benchmarks card grid.
 * Hosts category pills (derived from data), a view-mode toggle (grid is
 * the only fully-implemented mode here - list view degrades to a single
 * column) and a search input with a ⌘K affordance.
 *
 * The category pills render as `<Link>` to `/benchmarks/category/<slug>`
 * so crawlers see real hrefs and can follow them into the per-category
 * hub pages (otherwise the category facet would only exist as
 * client-only state and have no linkable URL). On click we still apply
 * the in-place client filter and preventDefault so the user gets the
 * snappy instant-filter UX without a navigation roundtrip.
 *
 * When `lockedCategory` is passed (e.g. by the `/benchmarks/category/<slug>`
 * page) the grid renders pre-filtered, the search bar still works, and
 * the category pills are hidden entirely so the page reads as a focused
 * category hub instead of a partial filter UI.
 */
export function BenchmarkGrid({
  benchmarks,
  lockedCategory = null,
  allCategories,
}: {
  benchmarks: Benchmark[];
  /** When set, force the grid to this category. The pill row still
   *  renders so users can jump to other category hubs via the same UI
   *  they had on the /benchmarks root. */
  lockedCategory?: string | null;
  /** Full category list to show in the pills, used by the category hub
   *  routes where the `benchmarks` prop is pre-filtered to a single
   *  category. If unset, the grid derives pills from `benchmarks`. */
  allCategories?: string[];
}) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(
    lockedCategory,
  );
  const [view, setView] = useState<"grid" | "list">("grid");
  const q = query.trim().toLowerCase();

  const categories = useMemo(() => {
    if (allCategories && allCategories.length > 0) return allCategories;
    const seen = new Set<string>();
    const list: string[] = [];
    for (const b of benchmarks) {
      if (!seen.has(b.category)) {
        seen.add(b.category);
        list.push(b.category);
      }
    }
    return list;
  }, [benchmarks, allCategories]);

  const filtered = useMemo(() => {
    return benchmarks.filter((b) => {
      if (activeCategory && b.category !== activeCategory) return false;
      if (!q) return true;
      const haystack = [
        b.title,
        b.subtitle,
        b.category,
        b.metric,
        ...b.results.map((r) => r.name),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [benchmarks, q, activeCategory]);

  // Pills always render. When the grid is locked to a category route,
  // pill clicks navigate (no preventDefault) so the user moves between
  // /benchmarks/category/<slug> URLs. On the unlocked /benchmarks page
  // they filter in place for a snappier UX without a navigation
  // roundtrip.
  return (
    <div>
      {/* Filter row */}
      <div className="mb-8 flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3">
        <ul className="-mx-4 px-4 sm:mx-0 sm:px-0 flex flex-nowrap sm:flex-wrap overflow-x-auto sm:overflow-visible items-center gap-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <li>
            <Link
              href="/benchmarks"
              className="pill"
              data-active={!lockedCategory && activeCategory === null}
              onClick={(e) => {
                if (lockedCategory) return;
                e.preventDefault();
                setActiveCategory(null);
              }}
            >
              All
            </Link>
          </li>
          {categories.map((c) => {
            const slug = categorySlugFromLabel(c);
            const href = slug ? `/benchmarks/category/${slug}` : "/benchmarks";
            const isActive = lockedCategory === c || (!lockedCategory && activeCategory === c);
            return (
              <li key={c}>
                <Link
                  href={href}
                  className="pill"
                  data-active={isActive}
                  onClick={(e) => {
                    if (lockedCategory) return;
                    e.preventDefault();
                    setActiveCategory(activeCategory === c ? null : c);
                  }}
                >
                  {c}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="sm:ml-auto flex items-center gap-3">
          {/* View toggle */}
          <div className="hidden sm:inline-flex items-center rounded-md border border-rule p-0.5 bg-surface">
            <button
              type="button"
              aria-label="Grid view"
              onClick={() => setView("grid")}
              className={`inline-flex items-center justify-center w-7 h-7 rounded transition-colors ${
                view === "grid"
                  ? "bg-accent-soft text-accent border border-accent/30"
                  : "text-ink-muted hover:text-ink hover:bg-paper-soft"
              }`}
            >
              <LayoutGrid size={14} strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label="List view"
              onClick={() => setView("list")}
              className={`inline-flex items-center justify-center w-7 h-7 rounded transition-colors ${
                view === "list"
                  ? "bg-accent-soft text-accent border border-accent/30"
                  : "text-ink-muted hover:text-ink hover:bg-paper-soft"
              }`}
            >
              <List size={14} strokeWidth={2} />
            </button>
          </div>

          {/* Search */}
          <label className="group relative flex items-center flex-1 sm:flex-none sm:w-56 focus-within:sm:w-72 transition-[width] duration-200">
            <Search
              size={13}
              strokeWidth={2}
              className="absolute left-2.5 text-ink-faint group-focus-within:text-ink-muted pointer-events-none"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search benchmarks"
              className="w-full pl-7 pr-10 py-1.5 text-xs bg-surface border border-rule rounded-md focus:outline-none focus:border-ink/40 placeholder:text-ink-faint transition-colors"
            />
            <kbd className="absolute right-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-rule font-mono text-[9px] text-ink-faint bg-surface pointer-events-none">
              ⌘K
            </kbd>
          </label>
        </div>
      </div>

      {/* Results */}
      {filtered.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-base text-ink-muted">
            No benchmark matches{" "}
            {q && <span className="font-mono text-ink">&quot;{query}&quot;</span>}
            {q && activeCategory && " in "}
            {activeCategory && (
              <span className="font-mono text-ink">{activeCategory}</span>
            )}
            .
          </p>
        </div>
      ) : (
        <div
          className={
            view === "grid"
              ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
              : "grid grid-cols-1 gap-4"
          }
        >
          {filtered.map((b) => (
            <BenchmarkCard key={b.slug} benchmark={b} />
          ))}
        </div>
      )}
    </div>
  );
}
