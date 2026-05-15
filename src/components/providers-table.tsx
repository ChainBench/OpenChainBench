"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { LetterAvatar } from "@/components/letter-avatar";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import type { Benchmark } from "@/types/benchmark";

type Row = {
  slug: string;
  name: string;
  type?: string;
  appearances: number;
  wins: number;
  categories: Benchmark["category"][];
};

const ALL = "ALL";

/**
 * Live-filterable products list. The server page hands us the aggregated
 * profiles; this wrapper layers a category-pill filter + text search on
 * top, then renders flat rows (not a table) per the redesign spec.
 */
export function ProvidersTable({ providers }: { providers: Row[] }) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>(ALL);
  const q = query.trim().toLowerCase();

  // Categories actually present in the data, in stable first-seen order.
  const categories = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const p of providers) {
      for (const c of p.categories) {
        if (!seen.has(c)) {
          seen.add(c);
          ordered.push(c);
        }
      }
    }
    return ordered;
  }, [providers]);

  const filtered = useMemo(() => {
    return providers.filter((p) => {
      if (activeCategory !== ALL && !p.categories.includes(activeCategory as Benchmark["category"])) {
        return false;
      }
      if (!q) return true;
      const haystack = [p.name, p.slug, p.type ?? "", ...p.categories]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [providers, q, activeCategory]);

  return (
    <div>
      {/* Filter row: category pills + search */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <button
          type="button"
          onClick={() => setActiveCategory(ALL)}
          data-active={activeCategory === ALL}
          className="pill"
        >
          All
        </button>
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setActiveCategory(c)}
            data-active={activeCategory === c}
            className="pill"
          >
            {c}
          </button>
        ))}

        <label className="group relative flex items-center ml-auto w-56 focus-within:w-72 transition-[width] duration-200">
          <Search
            size={14}
            strokeWidth={2}
            className="absolute left-3 text-ink-faint group-focus-within:text-ink-muted pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products..."
            className="w-full pl-9 pr-12 py-2 text-sm bg-white border border-rule rounded-md focus:outline-none focus:border-ink/40 placeholder:text-ink-faint transition-colors"
          />
          <span className="absolute right-2 hidden sm:inline-flex items-center font-mono text-[10px] tracking-[0.12em] text-ink-faint border border-rule rounded px-1.5 py-0.5 pointer-events-none">
            ⌘K
          </span>
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="py-16 text-center text-sm text-ink-muted">
          No product matches
          {q && (
            <>
              {" "}
              <span className="font-mono text-ink">&quot;{query}&quot;</span>
            </>
          )}
          .
        </p>
      ) : (
        <ol className="border-t border-rule">
          {filtered.map((p) => (
            <li key={p.slug} className="border-b border-rule">
              <Link
                href={`/providers/${p.slug}`}
                className="group flex items-center gap-4 py-5 px-2 hover:bg-paper-soft/40 transition-colors"
              >
                <LetterAvatar slug={p.slug} name={p.name} size={52} />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-base sm:text-lg font-semibold text-ink leading-tight truncate">
                      {p.name}
                    </h3>
                    {p.type && (
                      <span className="pill" style={{ padding: "0.15rem 0.5rem", fontSize: 9 }}>
                        {p.type}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-ink-muted truncate">
                    {p.categories
                      .map((c) => (
                        <span
                          key={c}
                          style={{ color: CATEGORY_COLOR[c] ?? "var(--color-ink-muted)" }}
                        >
                          {c}
                        </span>
                      ))
                      .reduce<React.ReactNode[]>((acc, el, i) => {
                        if (i > 0)
                          acc.push(
                            <span key={`s-${i}`} className="text-ink-faint">
                              {" "}
                              ·{" "}
                            </span>,
                          );
                        acc.push(el);
                        return acc;
                      }, [])}
                  </p>
                </div>

                <div className="flex items-center gap-8 sm:gap-12 pr-2">
                  <div className="text-right min-w-[72px]">
                    <p className="label-mono text-ink-faint">Benchmarks</p>
                    <p className="mt-1 font-semibold text-base text-ink tabular">
                      {p.appearances}
                    </p>
                  </div>
                  <div className="text-right min-w-[56px]">
                    <p className="label-mono text-ink-faint">Top 1</p>
                    <p
                      className={`mt-1 font-semibold text-base tabular ${
                        p.wins > 0 ? "text-good" : "text-ink-faint"
                      }`}
                    >
                      {p.wins}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
