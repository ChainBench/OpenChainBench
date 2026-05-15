"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
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

/**
 * Live-filterable providers table. Server page fetches the aggregate
 * list, this wrapper handles the search input + match across name,
 * slug, type, and category.
 */
export function ProvidersTable({ providers }: { providers: Row[] }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return providers;
    return providers.filter((p) => {
      const haystack = [p.name, p.slug, p.type ?? "", ...p.categories]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [providers, q]);

  return (
    <div>
      <div className="mt-8 flex items-center gap-3">
        {q && (
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            {filtered.length} of {providers.length}
          </span>
        )}
        <label className="group relative flex items-center ml-auto w-44 focus-within:w-64 transition-[width] duration-200">
          <Search
            size={13}
            strokeWidth={2}
            className="absolute left-2.5 text-ink-faint group-focus-within:text-ink-muted pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search providers"
            className="w-full pl-7 pr-2 py-1 text-xs bg-transparent border-b border-rule focus:outline-none focus:border-ink/60 placeholder:text-ink-faint transition-colors"
          />
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-ink-muted">
          No provider matches{" "}
          <span className="font-mono text-ink">&quot;{query}&quot;</span>.
        </p>
      ) : (
        <ol className="mt-3 divide-y divide-rule border-y border-rule">
          {filtered.map((p) => (
            <li key={p.slug}>
              <Link
                href={`/providers/${p.slug}`}
                className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 py-5 pl-3 pr-3 hover:bg-paper-soft/60 transition-colors"
              >
                <ProviderLogo slug={p.slug} name={p.name} size={32} />
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <h3 className="display text-base sm:text-lg font-semibold text-ink leading-tight truncate">
                      {p.name}
                    </h3>
                    {p.type && (
                      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
                        {p.type}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 font-mono text-[11px] tracking-wide text-ink-muted truncate">
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
                <div className="text-right">
                  <p className="font-mono tabular text-sm text-ink">
                    {p.appearances}
                    <span className="text-ink-faint">
                      {" "}
                      bench{p.appearances === 1 ? "" : "es"}
                    </span>
                  </p>
                  {p.wins > 0 && (
                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-good">
                      {p.wins} #1
                    </p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
