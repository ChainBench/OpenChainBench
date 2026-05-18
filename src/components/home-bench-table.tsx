import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";
import { MiniChart } from "@/components/mini-chart";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import { leader, fieldValue } from "@/lib/citation";
import { fmtValue, unitSuffix } from "@/lib/format";

/**
 * "Latest deployed benchmarks" preview table on the home page.
 *
 * 3-column row: title cluster | 24h chart | value. Top 5 benchmarks by
 * `lastRunAt`. Matches the home design — a row-style list, not the
 * card grid that lives at /benchmarks.
 */
export function HomeBenchTable({ benchmarks }: { benchmarks: Benchmark[] }) {
  const top = [...benchmarks]
    .sort((a, b) => (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""))
    .slice(0, 5);

  return (
    <section>
      <header className="flex items-baseline justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <span className="label-mono text-ink-faint">Latest deployed benchmarks</span>
          <Link
            href="/benchmarks"
            className="pill"
            style={{ padding: "0.25rem 0.55rem", fontSize: 10 }}
          >
            See all
          </Link>
        </div>
        <div className="hidden md:flex items-center gap-12 label-mono text-ink-faint pr-4">
          <span>24 Hours</span>
          <span>Value</span>
        </div>
      </header>

      <ol className="border-t border-ink">
        {top.map((b) => (
          <li key={b.slug}>
            <Link
              href={`/benchmarks/${b.slug}`}
              className="group grid grid-cols-1 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_minmax(0,9rem)] items-center gap-4 sm:gap-8 py-3.5 px-3 border-b border-rule hover:bg-accent-soft/40 transition-colors"
            >
              <BenchTitleCell b={b} />
              <div className="hidden md:block min-w-0">
                {b.status === "live" ? (
                  <MiniChart benchmark={b} height={36} legend />
                ) : (
                  <span className="text-xs text-ink-faint italic">Awaiting samples</span>
                )}
              </div>
              <ValueCell b={b} />
            </Link>
          </li>
        ))}
      </ol>

      <div className="mt-6 flex justify-end">
        <Link
          href="/benchmarks"
          className="inline-flex items-center gap-1.5 label-mono text-ink-soft hover:text-ink transition-colors"
        >
          See all benchmarks
          <ArrowUpRight size={12} strokeWidth={2} />
        </Link>
      </div>
    </section>
  );
}

function BenchTitleCell({ b }: { b: Benchmark }) {
  const catColor = CATEGORY_COLOR[b.category] ?? "var(--color-ink-muted)";
  const chips = b.results.slice(0, 4);
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="font-sans text-[10px] uppercase tracking-[0.18em] shrink-0 font-medium"
          style={{ color: catColor }}
        >
          {b.category}
        </span>
        <ul className="flex items-center gap-1">
          {chips.map((c) => (
            <li
              key={c.slug}
              className="inline-flex items-center justify-center w-5 h-5 rounded-full border border-rule bg-surface text-[9px] font-semibold text-ink-muted"
              title={c.name}
            >
              {c.name.charAt(0)}
            </li>
          ))}
        </ul>
      </div>
      <h3 className="mt-1.5 text-base sm:text-lg font-semibold text-ink leading-tight truncate group-hover:text-accent transition-colors">
        {b.title}
      </h3>
      <p className="mt-0.5 text-xs text-ink-muted truncate">{b.subtitle}</p>
    </div>
  );
}

function ValueCell({ b }: { b: Benchmark }) {
  const v = fieldValue(b);
  if (v == null) {
    const top = leader(b);
    return (
      <p className="text-right text-ink-faint italic text-sm">
        {top ? "n/a" : "awaiting"}
      </p>
    );
  }
  return (
    <p className="text-right">
      <span className="display-num text-2xl sm:text-3xl text-ink">
        {fmtValue(v, b.unit)}
      </span>
      <span className="ml-1 text-sm text-ink-muted">{unitSuffix(b.unit).trim()}</span>
    </p>
  );
}
