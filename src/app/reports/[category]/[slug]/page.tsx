import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { MDXRemote } from "next-mdx-remote/rsc";
import { StatTable } from "@/components/reports/stat-table";
import {
  getAllReports,
  getReport,
  REPORT_CATEGORY_META,
} from "@/lib/reports/loader";
import { safeJsonLd } from "@/lib/jsonld";
import { PERSON_ID } from "@/lib/hub-jsonld";
import { SITE } from "@/data/site";

export const revalidate = 3600;

const SERIF: React.CSSProperties = { fontFamily: "var(--font-serif)" };

type Props = { params: Promise<{ category: string; slug: string }> };

export async function generateStaticParams() {
  const reports = getAllReports();
  return reports.map((r) => ({ category: r.categorySlug, slug: r.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { category, slug } = await params;
  const report = getReport(category, slug);
  if (!report) return {};

  const canonical = `${SITE.url}/reports/${category}/${slug}`;
  const ogImage = report.ogImage ?? `${SITE.url}/opengraph-image`;
  const social = `${report.title} · OpenChainBench`;

  return {
    title: report.title,
    description: report.summary,
    alternates: { canonical },
    openGraph: {
      title: social,
      description: report.summary,
      url: canonical,
      type: "article",
      siteName: "OpenChainBench",
      publishedTime: new Date(report.publishedAt).toISOString(),
      authors: [report.author],
      images: [{ url: ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: social,
      description: report.summary,
      site: "@OpenChainBench",
      images: [ogImage],
    },
  };
}

const MDX_COMPONENTS = {
  StatTable,
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <div className="mt-16 mb-8 flex items-center gap-5">
      <div className="flex-1 h-px bg-rule" />
      <h2 className="label-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted whitespace-nowrap shrink-0">
        {props.children}
      </h2>
      <div className="flex-1 h-px bg-rule" />
    </div>
  ),
  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3
      className="display mt-10 mb-4 text-xl sm:text-2xl tracking-tight text-ink"
      {...props}
    />
  ),
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p
      className="mt-5 text-[17px] leading-[1.85] text-ink-soft"
      style={SERIF}
      {...props}
    />
  ),
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <ul
      className="mt-5 space-y-2 pl-6 list-disc text-[17px] leading-[1.85] text-ink-soft"
      style={SERIF}
      {...props}
    />
  ),
  ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
    <ol
      className="mt-5 space-y-2 pl-6 list-decimal text-[17px] leading-[1.85] text-ink-soft"
      style={SERIF}
      {...props}
    />
  ),
  li: (props: React.HTMLAttributes<HTMLLIElement>) => (
    <li className="pl-1" {...props} />
  ),
  blockquote: (props: React.HTMLAttributes<HTMLElement>) => (
    <blockquote
      className="my-10 border-y-2 border-ink py-7 text-center [&_p]:mt-0 [&_p]:text-xl [&_p]:leading-snug [&_p]:text-ink [&_p]:italic"
      style={SERIF}
      {...props}
    />
  ),
  code: (props: React.HTMLAttributes<HTMLElement>) => (
    <code
      className="label-mono text-[0.85em] bg-[var(--color-paper-soft)] border border-rule px-1.5 py-0.5"
      {...props}
    />
  ),
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
    <pre
      className="my-8 overflow-x-auto bg-ink text-paper p-5 text-sm label-mono leading-relaxed"
      {...props}
    />
  ),
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a className="lnk" {...props} />
  ),
  strong: (props: React.HTMLAttributes<HTMLElement>) => (
    <strong className="font-semibold text-ink" {...props} />
  ),
  hr: () => <div className="my-12 h-px bg-rule" />,
};

function reportJsonLd(report: ReturnType<typeof getReport>) {
  if (!report) return [];
  const url = `${SITE.url}/reports/${report.categorySlug}/${report.slug}`;
  const catMeta = REPORT_CATEGORY_META[report.categorySlug];

  return [
    {
      "@context": "https://schema.org",
      "@type": "Article",
      "@id": `${url}#article`,
      url,
      headline: report.title,
      description: report.summary,
      datePublished: new Date(report.publishedAt).toISOString(),
      dateModified: new Date(report.publishedAt).toISOString(),
      image: report.ogImage ?? `${SITE.url}/opengraph-image`,
      author: { "@id": PERSON_ID },
      publisher: { "@id": `${SITE.url}/#org` },
      inLanguage: "en",
      license: "https://creativecommons.org/licenses/by/4.0/",
      isPartOf: { "@id": `${SITE.url}/reports/${report.categorySlug}#series` },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${SITE.url}/` },
        { "@type": "ListItem", position: 2, name: "Reports", item: `${SITE.url}/reports` },
        {
          "@type": "ListItem",
          position: 3,
          name: catMeta?.label ?? report.categorySlug,
          item: `${SITE.url}/reports/${report.categorySlug}`,
        },
        { "@type": "ListItem", position: 4, name: report.title, item: url },
      ],
    },
  ];
}

export default async function ReportPage({ params }: Props) {
  const { category, slug } = await params;
  const report = getReport(category, slug);
  if (!report) notFound();

  const catMeta = REPORT_CATEGORY_META[category];
  const lds = reportJsonLd(report);

  return (
    <article className="mx-auto max-w-[740px] px-4 sm:px-6 py-8 sm:py-14">
      {lds.map((ld, i) => (
        <script
          key={i}
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(ld) }}
        />
      ))}

      <nav className="mb-8 flex items-center gap-2 label-mono text-[11px] text-ink-muted">
        <Link href="/reports" className="hover:text-ink transition-colors">
          Reports
        </Link>
        <span>/</span>
        <Link
          href={`/reports/${category}`}
          className="hover:text-ink transition-colors"
        >
          {catMeta?.label ?? category}
        </Link>
        <span>/</span>
        <span className="text-ink truncate max-w-[200px]">{report.period}</span>
      </nav>

      <header className="border-b-2 border-ink pb-10 mb-2">
        <div className="flex items-center gap-2 mb-5">
          <span className="label-mono text-[10px] border border-ink px-2 py-0.5 text-ink uppercase tracking-[0.12em]">
            {catMeta?.label ?? category}
          </span>
          <span className="label-mono text-[10px] text-ink-faint">
            {report.period}
          </span>
        </div>

        <h1 className="display text-4xl sm:text-5xl tracking-tight leading-[1.05]">
          {report.title}
        </h1>

        <p
          className="mt-5 text-lg sm:text-xl leading-relaxed text-ink-soft"
          style={SERIF}
        >
          {report.summary}
        </p>

        <div className="mt-7 border-l-[3px] border-ink pl-5 py-0.5">
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

        <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] label-mono text-ink-muted border-t border-rule pt-4">
          <span>
            By{" "}
            <Link href="/team" className="lnk">
              {report.author}
            </Link>
          </span>
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
      </header>

      <div className="mt-2">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <MDXRemote source={report.content} components={MDX_COMPONENTS as any} />
      </div>

      <div className="mt-16 flex items-center gap-4">
        <div className="flex-1 h-px bg-rule" />
        <span className="label-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted shrink-0">
          Filed under
        </span>
        <div className="flex-1 h-px bg-rule" />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={`/reports/${category}`}
          className="label-mono text-[11px] border border-rule px-2 py-1 text-ink-muted hover:text-ink hover:border-ink transition-colors"
        >
          {catMeta?.label ?? category} reports
        </Link>
        <Link
          href="/reports"
          className="label-mono text-[11px] border border-rule px-2 py-1 text-ink-muted hover:text-ink hover:border-ink transition-colors"
        >
          All reports
        </Link>
      </div>

      <div className="mt-10 border border-rule p-6 text-sm text-ink-muted leading-relaxed bg-[var(--color-paper-soft)]">
        <p className="label-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted mb-3">
          Cite this report
        </p>
        <p>
          OpenChainBench Research. <em>{report.title}</em>. OpenChainBench,{" "}
          {new Date(report.publishedAt).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: "UTC",
          })}
          .{" "}
          <a className="lnk" href={report.canonical}>
            {report.canonical}
          </a>
          . Licensed under CC BY 4.0.
        </p>
      </div>
    </article>
  );
}
