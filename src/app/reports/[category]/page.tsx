import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { SectionRule } from "@/components/section-rule";
import { ReportCard } from "@/components/reports/report-card";
import {
  getAllReportCategories,
  getReportsByCategory,
  REPORT_CATEGORY_META,
} from "@/lib/reports/loader";
import { pageMetadata } from "@/lib/page-metadata";

type Props = { params: Promise<{ category: string }> };

export async function generateStaticParams() {
  return getAllReportCategories().map((category) => ({ category }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { category } = await params;
  const meta = REPORT_CATEGORY_META[category];
  if (!meta) return {};
  return pageMetadata({
    path: `/reports/${category}`,
    title: `${meta.label} Reports`,
    description: meta.description,
  });
}

export default async function CategoryPage({ params }: Props) {
  const { category } = await params;
  const meta = REPORT_CATEGORY_META[category];
  if (!meta) notFound();

  const reports = getReportsByCategory(category);

  return (
    <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <nav className="mb-6 flex items-center gap-2 label-mono text-[11px] text-ink-muted">
        <Link href="/reports" className="hover:text-ink transition-colors">
          Reports
        </Link>
        <span>/</span>
        <span className="text-ink">{meta.label}</span>
      </nav>

      <header className="border-b-2 border-ink pb-6 max-w-3xl">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">
          {meta.label} Reports
        </h1>
        <p className="mt-3 text-base sm:text-lg text-ink-soft leading-snug max-w-2xl">
          {meta.description}
        </p>
        <div className="mt-4">
          <a
            href={`/reports/${category}/rss.xml`}
            className="label-mono text-[11px] border border-rule px-2 py-1 text-ink-muted hover:text-ink hover:border-ink transition-colors"
          >
            RSS feed
          </a>
        </div>
      </header>

      {reports.length === 0 ? (
        <div className="mt-14 text-ink-muted text-base">
          No {meta.label} reports published yet. Check back soon.
        </div>
      ) : (
        <>
          <SectionRule label={`${meta.label} reports`} number="i" />
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {reports.map((r) => (
              <ReportCard key={r.slug} report={r} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
