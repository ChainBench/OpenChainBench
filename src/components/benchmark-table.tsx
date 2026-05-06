"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";
import { MiniChart } from "@/components/mini-chart";
import { fmtValue, unitSuffix } from "@/lib/format";
import { leader } from "@/lib/ranking";
import { CATEGORY_COLOR } from "@/lib/category-colors";

/**
 * Live-filterable benchmark table — used on the home `/` page.
 * Server component fetches the full list; this client wrapper handles
 * the search input + matching against title / subtitle / category /
 * provider names. No API round-trip.
 */
export function BenchmarkTable({ benchmarks }: { benchmarks: Benchmark[] }) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const q = query.trim().toLowerCase();

  // Categories present in the data, in the order benchmarks declare them.
  const categories = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const b of benchmarks) {
      if (!seen.has(b.category)) {
        seen.add(b.category);
        list.push(b.category);
      }
    }
    return list;
  }, [benchmarks]);

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

  return (
    <div>
      {/* Filter row — categories left, search right */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ul className="flex flex-wrap items-center gap-1">
          <CategoryPill
            label="All"
            active={activeCategory === null}
            onClick={() => setActiveCategory(null)}
          />
          {categories.map((c) => (
            <CategoryPill
              key={c}
              label={c}
              color={CATEGORY_COLOR[c]}
              active={activeCategory === c}
              onClick={() =>
                setActiveCategory(activeCategory === c ? null : c)
              }
            />
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-3">
          {(q || activeCategory) && (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
              {filtered.length} of {benchmarks.length}
            </span>
          )}
          <label className="group relative flex items-center w-44 focus-within:w-64 transition-[width] duration-200">
            <Search
              size={13}
              strokeWidth={2}
              className="absolute left-2.5 text-ink-faint group-focus-within:text-ink-muted pointer-events-none"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="w-full pl-7 pr-2 py-1 text-xs bg-transparent border-b border-rule focus:outline-none focus:border-ink/60 placeholder:text-ink-faint transition-colors"
            />
          </label>
        </div>
      </div>

      {/* Table head — same grid as rows so columns align cleanly. */}
      <div
        className="hidden sm:grid grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_6rem] items-end gap-4 sm:gap-6 border-b-2 border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted"
        role="row"
      >
        <span className="pl-1">№</span>
        <span>Benchmark</span>
        <span>24 Hours</span>
        <span className="text-right">Value</span>
      </div>
      <div className="sm:hidden flex items-end justify-between border-b-2 border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        <span>Benchmark</span>
        <span>Value</span>
      </div>

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-ink-muted">
          No benchmark matches{" "}
          {q && <span className="font-mono text-ink">&quot;{query}&quot;</span>}
          {q && activeCategory && " in "}
          {activeCategory && (
            <span className="font-mono text-ink">{activeCategory}</span>
          )}
          .
        </p>
      ) : (
        <ol className="divide-y divide-rule border-b border-rule">
          {filtered.map((b) => {
            const lead = leader(b);
            const isDraft = b.status === "draft";
            const catColor = CATEGORY_COLOR[b.category];
            return (
              <li key={b.slug}>
                <Link
                  href={`/benchmarks/${b.slug}`}
                  style={{ ["--cat-color" as string]: catColor ?? "var(--color-ink)" }}
                  className="group relative grid grid-cols-[2.5rem_1fr] sm:grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_6rem] items-center gap-4 sm:gap-6 py-5 hover:bg-paper-soft/60 transition-colors before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-[var(--cat-color)] before:opacity-0 before:transition-opacity hover:before:opacity-100"
                >
                  <span
                    className="font-mono text-[12px] font-medium tabular pl-1"
                    style={{ color: catColor ?? "var(--color-ink-soft)" }}
                  >
                    № {b.number}
                  </span>

                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span
                        className="font-mono text-[10px] uppercase tracking-[0.18em] shrink-0"
                        style={{ color: catColor ?? "var(--color-ink-faint)" }}
                      >
                        {b.category}
                      </span>
                      {isDraft && (
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                          draft
                        </span>
                      )}
                    </div>
                    <h3 className="mt-1 display text-base sm:text-lg font-semibold text-ink leading-tight truncate">
                      {b.title}
                    </h3>
                    <p className="mt-0.5 text-xs text-ink-muted truncate">{b.subtitle}</p>
                  </div>

                  <div className="hidden sm:block min-w-0">
                    {!isDraft && (
                      <MiniChart benchmark={b} height={32} legend className="opacity-90" />
                    )}
                  </div>

                  <div className="hidden sm:flex justify-end items-baseline">
                    {lead && !isDraft ? (
                      <span className="font-mono tabular text-base sm:text-lg text-ink leading-none">
                        {fmtValue(lead.ms.p50, b.unit)}
                        <span className="text-ink-faint text-sm">{unitSuffix(b.unit)}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-ink-faint">—</span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function CategoryPill({
  label,
  color,
  active,
  onClick,
}: {
  label: string;
  color?: string;
  active: boolean;
  onClick: () => void;
}) {
  const accent = color ?? "var(--color-ink)";
  return (
    <li>
      <button
        onClick={onClick}
        style={
          active
            ? { background: accent, borderColor: accent, color: "var(--color-paper)" }
            : { color: accent, borderColor: "var(--color-rule)" }
        }
        className="px-2.5 py-1 border rounded-sm font-mono text-[10px] uppercase tracking-[0.18em] transition-colors hover:bg-paper-soft/60"
      >
        {label}
      </button>
    </li>
  );
}
