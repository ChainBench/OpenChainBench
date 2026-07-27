import type { Metadata } from "next";
import Link from "next/link";
import { SectionRule } from "@/components/section-rule";
import { ReportCard } from "@/components/reports/report-card";
import { getAllReports, REPORT_CATEGORY_META } from "@/lib/reports/loader";
import { pageMetadata } from "@/lib/page-metadata";
import { reportsLandingLd } from "@/lib/hub-jsonld";
import { safeJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

export const metadata: Metadata = pageMetadata({
  path: "/reports",
  title: "Reports",
  description:
    "Monthly and quarterly research reports on crypto infrastructure performance: RPC reliability, bridge fees, and prediction markets. Citable, reproducible, CC BY 4.0.",
});

export default function ReportsPage() {
  const reports = getAllReports();
  const categories = Object.entries(REPORT_CATEGORY_META) as Array<[string, { label: string; description: string }]>;

  return (
    <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      {reportsLandingLd().map((ld, i) => (
        <script
          key={i}
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(ld) }}
        />
      ))}
      <header className="border-b-2 border-ink pb-6 max-w-3xl">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">
          Reports
        </h1>
        <p className="mt-3 text-base sm:text-lg text-ink-soft leading-snug max-w-2xl">
          Monthly and quarterly research on crypto infrastructure. Every figure
          is live data from the open benchmarks, citable under CC BY 4.0.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <a
            href="/reports/rss.xml"
            className="label-mono text-[11px] border border-rule px-2 py-1 text-ink-muted hover:text-ink hover:border-ink transition-colors"
          >
            RSS feed
          </a>
          <a
            href={`https://x.com/${SITE.twitter}`}
            target="_blank"
            rel="noopener noreferrer"
            className="label-mono text-[11px] border border-rule px-2 py-1 text-ink-muted hover:text-ink hover:border-ink transition-colors"
          >
            {SITE.twitter} on X
          </a>
        </div>
      </header>

      {reports.length === 0 ? (
        <div className="mt-14 text-ink-muted text-base">
          No reports published yet. Check back soon.
        </div>
      ) : (
        <>
          <SectionRule label="All reports" number="i" />
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {reports.map((r) => (
              <ReportCard key={`${r.categorySlug}/${r.slug}`} report={r} />
            ))}
          </div>
        </>
      )}

      <SectionRule label="By category" number="ii" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map(([slug, meta]) => (
          <Link
            key={slug}
            href={`/reports/${slug}`}
            className="group block border border-rule hover:border-ink/40 transition-colors p-5"
          >
            <h2 className="font-semibold tracking-tight text-base group-hover:text-ink-soft transition-colors">
              {meta.label}
            </h2>
            <p className="mt-1.5 text-sm text-ink-muted leading-relaxed">
              {meta.description}
            </p>
            <span className="mt-3 inline-block label-mono text-[11px] text-ink-faint group-hover:text-ink-muted transition-colors">
              View reports
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
