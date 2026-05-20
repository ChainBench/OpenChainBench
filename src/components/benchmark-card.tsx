import Link from "next/link";
import type { Benchmark } from "@/types/benchmark";
import { MiniChart } from "@/components/mini-chart";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import { fmtValue, unitSuffix } from "@/lib/format";

/**
 * Card tile for the All Benchmarks grid. Self-contained - renders the
 * category badge, title, headline KPI (field-composite p50), a compact
 * MiniChart preview, and a 3-column footer (providers / samples / updated).
 * Drafts render the same skeleton with an "Awaiting first run" placeholder
 * in place of the chart and an em-dash where the headline number would be.
 */
export function BenchmarkCard({ benchmark }: { benchmark: Benchmark }) {
  const b = benchmark;
  const isDraft = b.status === "draft";
  const catColor = CATEGORY_COLOR[b.category] ?? "var(--color-ink-muted)";

  // Field composite p50: best-of-class (or worst if higher-is-better is
  // false). We pick the leader, same heuristic as the table.
  const sorted = [...b.results].sort(
    b.higherIsBetter ? (a, x) => x.ms.p50 - a.ms.p50 : (a, x) => a.ms.p50 - x.ms.p50,
  );
  const leader = sorted[0];
  const headlineValue = !isDraft && leader ? fmtValue(leader.ms.p50, b.unit) : "n/a";
  const headlineUnit = unitSuffix(b.unit).trim();

  // Top-right provider chips - first 3 results, single-letter circle badges.
  const chips = b.results.slice(0, 3);

  return (
    <Link
      href={`/benchmarks/${b.slug}`}
      className="card-soft p-6 flex flex-col gap-4 group"
    >
      {/* Top row - category + draft pill + provider chips */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="label-mono shrink-0"
            style={{ color: catColor }}
          >
            {b.category}
          </span>
          {isDraft && (
            <span className="pill" data-active="false">
              Draft
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {chips.map((r) => (
            <span
              key={r.slug}
              title={r.name}
              className="inline-flex items-center justify-center w-6 h-6 rounded-full border border-rule text-[10px] font-semibold text-ink-muted bg-surface"
            >
              {r.name.charAt(0).toUpperCase()}
            </span>
          ))}
        </div>
      </div>

      {/* Title */}
      <h3 className="display text-xl text-ink leading-tight">{b.title}</h3>

      {/* Label */}
      <p className="label-mono text-ink-faint">Field composite · P50</p>

      {/* Big number row */}
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="display-num text-5xl text-ink tabular">
            {headlineValue}
          </span>
          {headlineUnit && (
            <span className="text-xl text-ink-muted tabular">{headlineUnit}</span>
          )}
        </div>
        <span className="label-mono text-ink-faint shrink-0">24H</span>
      </div>

      {/* Chart preview - or draft placeholder */}
      <div className="min-h-[48px] flex items-center">
        {isDraft ? (
          <p className="label-mono text-ink-faint">Awaiting first run</p>
        ) : (
          <MiniChart benchmark={b} height={48} legend className="opacity-90 w-full" />
        )}
      </div>

      {/* Divider + footer */}
      <div className="border-t border-rule pt-4 grid grid-cols-3 gap-3">
        <Footer label="Providers" value={b.results.length.toString()} />
        <Footer label="N · 24H" value={b.sampleSize.toLocaleString()} />
        <Footer label="Updated" value={formatUpdated(b.lastRunAt)} />
      </div>
    </Link>
  );
}

function Footer({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="label-mono text-ink-faint">{label}</p>
      <p className="mt-1 text-sm text-ink truncate tabular">{value}</p>
    </div>
  );
}

/** "May 6, 2026, 9:17 AM UTC" - matches the spec wording. */
function formatUpdated(iso: string): string {
  if (!iso) return "n/a";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "n/a";
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
  return `${date}, ${time} UTC`;
}
