"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Benchmark } from "@/types/benchmark";
import { MiniChart } from "@/components/mini-chart";
import { fmtValue, unitSuffix } from "@/lib/format";
import { leader } from "@/lib/ranking";

const CATEGORY_COLOR: Record<string, string> = {
  Aggregators: "var(--color-accent, #c97c5d)",
  Data: "var(--color-good, #6a9466)",
  Bridges: "var(--color-warn, #c08a3c)",
  Wallets: "#7a6db8",
  RPCs: "#5da0a3",
};

/**
 * Live-filterable benchmark table — used on the home `/` page.
 * Server component fetches the full list; this client wrapper handles
 * the search input + matching against title / subtitle / category /
 * provider names. No API round-trip.
 */
export function BenchmarkTable({ benchmarks }: { benchmarks: Benchmark[] }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return benchmarks;
    return benchmarks.filter((b) => {
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
  }, [benchmarks, q]);

  return (
    <div>
      {/* Search bar — sits above the table head */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="relative flex items-center flex-1 min-w-[16rem] max-w-md">
          <span className="absolute left-3 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint pointer-events-none">
            /
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search benchmarks, providers, categories…"
            className="w-full pl-7 pr-3 py-2 text-sm bg-paper-soft/60 border border-rule rounded-sm focus:outline-none focus:border-ink/60 placeholder:text-ink-faint transition-colors"
          />
        </label>
        {q && (
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            {filtered.length} of {benchmarks.length}
          </span>
        )}
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
          <span className="font-mono text-ink">&quot;{query}&quot;</span>.
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
