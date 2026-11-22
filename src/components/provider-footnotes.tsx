import type { Benchmark, ProviderResult } from "@/types/benchmark";

export function ProviderFootnotes({
  benchmark,
  rows,
}: {
  benchmark: Benchmark;
  rows: ProviderResult[];
}) {
  const notes = benchmark.providerFootnotes ?? {};
  const noted = rows.filter((r) => notes[r.slug]);
  if (noted.length === 0) return null;
  return (
    <div className="sticky left-4 sm:left-0 mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink">
      {noted.map((r) => (
        <p key={r.slug}>
          <span aria-hidden className="font-semibold text-amber-700 dark:text-amber-300">*</span>{" "}
          <span className="font-semibold">{r.name}:</span> {notes[r.slug]}
        </p>
      ))}
    </div>
  );
}

export function FootnoteMark({
  benchmark,
  slug,
  className = "ml-0.5",
}: {
  benchmark: Benchmark;
  slug: string;
  className?: string;
}) {
  if (!benchmark.providerFootnotes?.[slug]) return null;
  return (
    <sup className={`${className} shrink-0 font-sans text-[13px] font-semibold text-amber-700 dark:text-amber-300`}>
      <span aria-hidden>*</span>
      <span className="sr-only">, see the note above the table</span>
    </sup>
  );
}
