import type { Metadata } from "next";
import Link from "next/link";
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

const SERIF: React.CSSProperties = { fontFamily: "var(--font-serif)" };

export default function ReportsPage() {
  const reports = getAllReports();
  const [featured, ...rest] = reports;
  const categories = Object.entries(REPORT_CATEGORY_META);

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

      {/* ── Masthead ── */}
      <header className="border-b-2 border-ink pb-6 mb-10">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="display text-3xl sm:text-4xl tracking-tight">Reports</h1>
            <p
              className="mt-2 text-base sm:text-lg text-ink-soft leading-relaxed max-w-xl"
              style={SERIF}
            >
              Research on crypto infrastructure performance. Every figure is live
              benchmark data, citable under CC&nbsp;BY&nbsp;4.0.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <a
              href="/reports/rss.xml"
              className="label-mono text-[11px] border border-rule px-2.5 py-1.5 text-ink-muted hover:text-ink hover:border-ink transition-colors"
            >
              RSS
            </a>
            <a
              href={`https://x.com/${SITE.twitter}`}
              target="_blank"
              rel="noopener noreferrer"
              className="label-mono text-[11px] border border-rule px-2.5 py-1.5 text-ink-muted hover:text-ink hover:border-ink transition-colors"
            >
              {SITE.twitter}
            </a>
          </div>
        </div>
      </header>

      {reports.length === 0 ? (
        <p className="text-ink-muted text-base mt-14">No reports published yet. Check back soon.</p>
      ) : (
        <div className="lg:grid lg:grid-cols-12 lg:gap-16">
          {/* ── Left: Featured + rest ── */}
          <div className="lg:col-span-8">
            {/* Featured latest report */}
            {featured && <ReportCard report={featured} featured />}

            {/* Grid of secondary reports */}
            {rest.length > 0 && (
              <div className="grid gap-5 sm:grid-cols-2">
                {rest.map((r) => (
                  <ReportCard key={`${r.categorySlug}/${r.slug}`} report={r} />
                ))}
              </div>
            )}
          </div>

          {/* ── Right: Category sidebar ── */}
          <aside className="lg:col-span-4 mt-12 lg:mt-0">
            <div className="sticky top-24 space-y-8">
              <div>
                <h2 className="label-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted mb-4">
                  Browse by topic
                </h2>
                <div className="space-y-px">
                  {categories.map(([slug, meta]) => (
                    <Link
                      key={slug}
                      href={`/reports/${slug}`}
                      className="group flex items-start justify-between gap-4 border border-rule hover:border-ink/40 transition-colors p-4"
                    >
                      <div>
                        <p className="font-medium text-sm text-ink group-hover:text-ink-soft transition-colors">
                          {meta.label}
                        </p>
                        <p className="mt-1 text-xs text-ink-muted leading-relaxed">
                          {meta.description}
                        </p>
                      </div>
                      <span className="label-mono text-[11px] text-ink-faint group-hover:text-ink-muted transition-colors shrink-0 mt-0.5">
                        →
                      </span>
                    </Link>
                  ))}
                </div>
              </div>

              <div className="border-t border-rule pt-6">
                <p className="label-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted mb-3">
                  Get updates
                </p>
                <p className="text-sm text-ink-muted leading-relaxed mb-3">
                  New reports ship every 2–3 months. Subscribe via RSS or follow on X.
                </p>
                <div className="flex flex-col gap-2">
                  <a
                    href="/reports/rss.xml"
                    className="label-mono text-[11px] border border-rule px-3 py-2 text-ink-muted hover:text-ink hover:border-ink transition-colors text-center"
                  >
                    RSS feed
                  </a>
                  <a
                    href={`https://x.com/${SITE.twitter}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="label-mono text-[11px] border border-rule px-3 py-2 text-ink-muted hover:text-ink hover:border-ink transition-colors text-center"
                  >
                    {SITE.twitter} on X
                  </a>
                </div>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
