import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { MDXRemote } from "next-mdx-remote/rsc";
import { SectionRule } from "@/components/section-rule";
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
  // Typography overrides so MDX content picks up the editorial design
  // without needing Tailwind @prose or a CSS module
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <div className="mt-14 mb-7">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
        {props.children}
      </h2>
      <div className="mt-2 h-px bg-rule" />
    </div>
  ),
  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3
      className="mt-8 mb-3 text-lg font-semibold tracking-tight text-ink"
      {...props}
    />
  ),
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="mt-4 text-base leading-relaxed text-ink-soft" {...props} />
  ),
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="mt-4 space-y-2 text-base leading-relaxed text-ink-soft" {...props} />
  ),
  ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
    <ol className="mt-4 space-y-2 text-base leading-relaxed text-ink-soft list-decimal list-inside" {...props} />
  ),
  li: (props: React.HTMLAttributes<HTMLLIElement>) => (
    <li className="flex gap-3" {...props}>
      <span className="text-ink-faint shrink-0">·</span>
      <span>{props.children}</span>
    </li>
  ),
  blockquote: (props: React.HTMLAttributes<HTMLElement>) => (
    <blockquote
      className="my-6 border-l-4 border-ink pl-6 py-2 text-base leading-relaxed text-ink-soft italic"
      {...props}
    />
  ),
  code: (props: React.HTMLAttributes<HTMLElement>) => (
    <code
      className="label-mono text-[0.85em] bg-[var(--color-paper-soft)] px-1 py-0.5 rounded"
      {...props}
    />
  ),
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
    <pre
      className="my-6 overflow-x-auto bg-ink text-paper p-4 text-sm label-mono leading-relaxed"
      {...props}
    />
  ),
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a className="lnk" {...props} />
  ),
  strong: (props: React.HTMLAttributes<HTMLElement>) => (
    <strong className="font-semibold text-ink" {...props} />
  ),
  hr: () => <div className="my-10 h-px bg-rule" />,
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
    <article className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
      {lds.map((ld, i) => (
        <script
          key={i}
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(ld) }}
        />
      ))}

      <nav className="mb-6 flex items-center gap-2 label-mono text-[11px] text-ink-muted">
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

      <header className="border-b-2 border-ink pb-8">
        <div className="flex items-center gap-2 mb-4">
          <span className="label-mono text-[10px] border border-ink px-2 py-0.5 text-ink uppercase">
            {catMeta?.label ?? category}
          </span>
          <span className="label-mono text-[10px] text-ink-faint">
            {report.period}
          </span>
        </div>

        <h1 className="display text-3xl sm:text-4xl tracking-tight leading-tight">
          {report.title}
        </h1>

        <blockquote className="mt-5 border-l-4 border-ink pl-5 text-base sm:text-lg leading-relaxed text-ink-soft italic">
          {report.heroFinding}
        </blockquote>

        <p className="mt-5 text-base text-ink-soft leading-relaxed">
          {report.summary}
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] label-mono text-ink-muted border-t border-rule pt-4">
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

      <SectionRule label="Filed under" />
      <div className="flex flex-wrap gap-2">
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

      <div className="mt-10 border border-rule p-5 text-sm text-ink-muted leading-relaxed">
        <strong className="text-ink label-mono text-[11px] uppercase tracking-wide">
          Cite this report
        </strong>
        <p className="mt-2">
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
