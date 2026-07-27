import Link from "next/link";
import type { ReportMeta } from "@/lib/reports/loader";
import { REPORT_CATEGORY_META } from "@/lib/reports/loader";

export function ReportCard({ report }: { report: ReportMeta }) {
  const catMeta = REPORT_CATEGORY_META[report.categorySlug];
  const href = `/reports/${report.categorySlug}/${report.slug}`;

  return (
    <article className="flex flex-col border border-rule hover:border-ink/40 transition-colors">
      <div className="p-6 flex flex-col flex-1">
        <div className="flex items-center gap-2 mb-4">
          <span className="label-mono text-[10px] border border-rule px-2 py-0.5 text-ink-muted uppercase">
            {catMeta?.label ?? report.categorySlug}
          </span>
          <span className="label-mono text-[10px] text-ink-faint">
            {report.period}
          </span>
        </div>

        <Link href={href} className="group flex-1">
          <h2 className="display text-xl font-semibold tracking-tight group-hover:text-ink-soft transition-colors leading-snug">
            {report.title}
          </h2>
          <p className="mt-3 text-sm text-ink-soft leading-relaxed">
            {report.summary}
          </p>
          <blockquote className="mt-4 border-l-2 border-ink pl-3 text-sm text-ink italic leading-relaxed">
            {report.heroFinding}
          </blockquote>
        </Link>

        <footer className="mt-5 flex items-center justify-between">
          <div className="flex items-center gap-3 text-[11px] label-mono text-ink-faint">
            <time dateTime={report.publishedAt}>
              {new Date(report.publishedAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
                timeZone: "UTC",
              })}
            </time>
            <span>·</span>
            <span>{report.readingTime} min read</span>
          </div>
          <Link
            href={href}
            className="label-mono text-[11px] text-ink-muted hover:text-ink transition-colors"
          >
            Read report
          </Link>
        </footer>
      </div>
    </article>
  );
}
