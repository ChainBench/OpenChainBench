import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { MDXRemote } from "next-mdx-remote/rsc";
import { StatTable } from "@/components/reports/stat-table";
import { RegionWinners } from "@/components/reports/region-winners";
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

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

const MDX_COMPONENTS = {
  StatTable,
  RegionWinners,

  // Table of contents — pipe-separated section names, auto-generates anchor hrefs
  TOC: ({ sections }: { sections: string }) => {
    const items = sections.split("|").map((s) => s.trim());
    return (
      <nav className="my-8 border border-ink/20 not-prose">
        <div className="px-5 py-3 border-b border-ink/10 bg-[var(--color-paper-soft)]">
          <p className="label-mono text-[10px] uppercase tracking-[0.22em] text-ink">In this report</p>
        </div>
        <ol className="divide-y divide-ink/[0.06]">
          {items.map((label, i) => (
            <li key={i}>
              <a
                href={`#${slugify(label)}`}
                className="flex items-center gap-4 px-5 py-2.5 text-[13px] text-ink-soft hover:text-ink hover:bg-[var(--color-paper-soft)] transition-colors no-underline"
              >
                <span className="label-mono text-[10px] text-ink-faint w-5 shrink-0 tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {label}
              </a>
            </li>
          ))}
        </ol>
      </nav>
    );
  },

  // Summary box — key findings list at article top
  Summary: ({ children }: { children: React.ReactNode }) => (
    <aside className="my-8 border border-ink/20 bg-[var(--color-paper-soft)] [&_ul]:mt-0 [&_ul]:space-y-2 [&_li]:text-[14px] [&_li]:leading-[1.6] [&_li]:text-ink-soft">
      <div className="px-5 py-3 border-b border-ink/10">
        <p className="label-mono text-[10px] uppercase tracking-[0.22em] text-ink">Key findings</p>
      </div>
      <div className="px-5 py-4">{children}</div>
    </aside>
  ),

  // Orange highlighter on key sentences
  Mark: ({ children }: { children: React.ReactNode }) => (
    <span
      className="font-semibold text-ink"
      style={{ background: "linear-gradient(transparent 55%, rgba(251,146,60,0.32) 55%)" }}
    >
      {children}
    </span>
  ),

  // Decision Framework card — used explicitly in MDX
  UseCase: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="mt-4 border border-rule hover:border-ink/50 transition-colors p-5">
      <p className="label-mono text-[10px] uppercase tracking-[0.2em] text-ink mb-1">
        {label}
      </p>
      <div className="[&_p]:mt-2 [&_p]:text-[16px] [&_p]:leading-[1.72]">
        {children}
      </div>
    </div>
  ),

  // Economist-style section header with scroll-target ID for TOC anchors
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => {
    const text = typeof props.children === "string" ? props.children : "";
    return (
      <div id={slugify(text)} className="mt-16 mb-8 border-t-[2px] border-ink pt-5 scroll-mt-6">
        <h2 className="label-mono text-[10px] uppercase tracking-[0.22em] text-ink">
          {props.children}
        </h2>
      </div>
    );
  },

  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3
      className="display mt-10 mb-3 text-xl sm:text-2xl tracking-tight text-ink"
      {...props}
    />
  ),

  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p
      className="mt-5 text-[17px] leading-[1.8] text-ink-soft"
      style={SERIF}
      {...props}
    />
  ),

  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <ul
      className="mt-5 space-y-2 pl-6 list-disc text-[17px] leading-[1.8] text-ink-soft"
      style={SERIF}
      {...props}
    />
  ),

  ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
    <ol
      className="mt-5 space-y-2 pl-6 list-decimal text-[17px] leading-[1.8] text-ink-soft"
      style={SERIF}
      {...props}
    />
  ),

  li: (props: React.HTMLAttributes<HTMLLIElement>) => (
    <li className="pl-1" {...props} />
  ),

  // Full-bleed pull quote
  blockquote: (props: React.HTMLAttributes<HTMLElement>) => (
    <blockquote
      className="my-10 border-y-2 border-ink py-7 text-center [&_p]:mt-0 [&_p]:text-xl [&_p]:sm:text-2xl [&_p]:leading-snug [&_p]:text-ink [&_p]:italic"
      style={SERIF}
      {...props}
    />
  ),

  // Inline code — pill style
  code: (props: React.HTMLAttributes<HTMLElement>) => (
    <code
      className="label-mono text-[0.85em] bg-[var(--color-paper-soft)] border border-rule px-1.5 py-0.5"
      {...props}
    />
  ),

  // Terminal window with decorative chrome
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
    <div className="my-8 border border-rule overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-rule bg-[var(--color-paper-soft)]">
        <span className="flex gap-1.5 shrink-0">
          <span className="w-2.5 h-2.5 rounded-full bg-ink-faint/25" />
          <span className="w-2.5 h-2.5 rounded-full bg-ink-faint/25" />
          <span className="w-2.5 h-2.5 rounded-full bg-ink-faint/25" />
        </span>
        <span className="label-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
          Terminal
        </span>
      </div>
      <pre
        className="overflow-x-auto bg-ink text-paper px-5 py-5 text-[13px] label-mono leading-[1.7] [&_code]:bg-transparent [&_code]:border-0 [&_code]:p-0"
        {...props}
      />
    </div>
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
    <article className="mx-auto max-w-[760px] px-4 sm:px-6 py-8 sm:py-14">
      {lds.map((ld, i) => (
        <script
          key={i}
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(ld) }}
        />
      ))}

      {/* Breadcrumb */}
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

      {/* Hero */}
      <header>
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

        {/* Key finding — visual centerpiece, full-bleed within article */}
        <div className="-mx-4 sm:-mx-6 mt-8 border-y-2 border-ink px-4 sm:px-6 py-10">
          <p className="label-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted text-center mb-5">
            Key finding
          </p>
          <p className="display text-2xl sm:text-[2rem] leading-[1.15] text-ink text-center max-w-[580px] mx-auto font-bold tracking-tight">
            {report.heroFinding}
          </p>
        </div>

        {/* Byline */}
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] label-mono text-ink-muted border-b border-rule pb-2">
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

      {/* Body */}
      <div className="mt-2">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <MDXRemote source={report.content} components={MDX_COMPONENTS as any} />
      </div>

      {/* Footer */}
      <div className="mt-16 border-t-[2px] border-ink pt-5 flex items-center justify-between gap-4">
        <span className="label-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          Filed under
        </span>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/reports/${category}`}
            className="label-mono text-[11px] border border-rule px-2 py-1 text-ink-muted hover:text-ink hover:border-ink transition-colors"
          >
            {catMeta?.label ?? category}
          </Link>
          <Link
            href="/reports"
            className="label-mono text-[11px] border border-rule px-2 py-1 text-ink-muted hover:text-ink hover:border-ink transition-colors"
          >
            All reports
          </Link>
        </div>
      </div>

      {/* Citation */}
      <div className="mt-8 border border-rule p-6 bg-[var(--color-paper-soft)]">
        <p className="label-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted mb-3">
          Cite this report
        </p>
        <p className="text-sm text-ink-muted leading-relaxed">
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
