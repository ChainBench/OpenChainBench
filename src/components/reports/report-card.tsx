import Link from "next/link";
import type { ReportMeta } from "@/lib/reports/loader";
import { REPORT_CATEGORY_META } from "@/lib/reports/loader";

const SERIF: React.CSSProperties = { fontFamily: "var(--font-serif)" };

export function ReportCard({
  report,
  featured = false,
}: {
  report: ReportMeta;
  featured?: boolean;
}) {
  const catMeta = REPORT_CATEGORY_META[report.categorySlug];
  const href = `/reports/${report.categorySlug}/${report.slug}`;

  if (featured) {
    return (
      <article className="border-b-2 border-ink pb-10 mb-10">
        <div className="flex items-center gap-3 mb-5">
          <span className="label-mono text-[10px] border border-ink px-2 py-1 text-ink uppercase tracking-[0.15em]">
            {catMeta?.label ?? report.categorySlug}
          </span>
          <span className="label-mono text-[10px] text-ink-faint uppercase tracking-[0.1em]">
            {report.period}
          </span>
        </div>

        <Link href={href} className="group block">
          <h2 className="display text-3xl sm:text-4xl lg:text-5xl tracking-tight leading-[1.05] text-ink group-hover:text-ink-soft transition-colors">
            {report.title}
          </h2>
        </Link>

        {/* Key finding — the hook */}
        <div className="mt-6 border-l-[3px] border-ink pl-5 py-0.5">
          <p className="label-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted mb-2">
            Key finding
          </p>
          <p
            className="text-lg sm:text-xl leading-snug text-ink italic"
            style={SERIF}
          >
            &ldquo;{report.heroFinding}&rdquo;
          </p>
        </div>

        <p className="mt-5 text-base leading-relaxed text-ink-soft" style={SERIF}>
          {report.summary}
        </p>

        <div className="mt-6 flex items-center justify-between">
          <div className="flex items-center gap-4 label-mono text-[11px] text-ink-faint">
            <time dateTime={report.publishedAt}>
              {new Date(report.publishedAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
                timeZone: "UTC",
              })}
            </time>
            <span>{report.readingTime} min read</span>
          </div>
          <Link
            href={href}
            className="label-mono text-[11px] border border-ink px-3 py-1.5 text-ink hover:bg-ink hover:text-paper transition-colors"
          >
            Read report
          </Link>
        </div>
      </article>
    );
  }

  // Standard card
  return (
    <article className="border border-rule hover:border-ink/40 transition-colors flex flex-col">
      <div className="p-5 flex flex-col flex-1">
        <div className="flex items-center gap-2 mb-4">
          <span className="label-mono text-[10px] border border-rule px-2 py-0.5 text-ink-muted uppercase tracking-[0.12em]">
            {catMeta?.label ?? report.categorySlug}
          </span>
          <span className="label-mono text-[10px] text-ink-faint">
            {report.period}
          </span>
        </div>

        <Link href={href} className="group flex-1">
          <h2 className="display text-xl tracking-tight leading-snug text-ink group-hover:text-ink-soft transition-colors">
            {report.title}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-ink-muted" style={SERIF}>
            {report.summary}
          </p>
        </Link>

        <div className="mt-5 pt-4 border-t border-rule flex items-center justify-between">
          <div className="label-mono text-[10px] text-ink-faint">
            <time dateTime={report.publishedAt}>
              {new Date(report.publishedAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              })}
            </time>
            {" · "}{report.readingTime} min
          </div>
          <Link
            href={href}
            className="label-mono text-[11px] text-ink-muted hover:text-ink transition-colors"
          >
            Read →
          </Link>
        </div>
      </div>
    </article>
  );
}
