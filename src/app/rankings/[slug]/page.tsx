import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { getBenchmark } from "@/data/benchmarks";
import { getRanking, getRankingSlugs, type RankingPage } from "@/data/rankings";
import { LiveIndicator } from "@/components/live-indicator";
import { SITE } from "@/data/site";
import { buildFaqPageJsonLd, safeJsonLd } from "@/lib/jsonld";
import { capDescription } from "@/lib/seo-text";
import { fmtUnit } from "@/lib/format";

// Rankings pages mirror their parent bench's ISR window. They never
// fetch their own Prom data — the leaderboard rendered below comes
// straight from `getBenchmark(bench.benchmark)`, so freshness is
// inherited 1:1 from the underlying bench.
export const revalidate = 60;
export const maxDuration = 60;

type Params = { slug: string };

export async function generateStaticParams() {
  return getRankingSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const ranking = getRanking(slug);
  if (!ranking) return {};

  const url = `${SITE.url}/rankings/${ranking.slug}`;
  const description = capDescription(ranking.metaDescription, 158);

  return {
    title: ranking.title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: ranking.title,
      description,
      url,
      type: "article",
      siteName: SITE.name,
      images: [`${SITE.url}/api/og/${ranking.benchmark}`],
    },
    twitter: {
      card: "summary_large_image",
      title: ranking.title,
      description,
      site: "@OpenChainBench",
      images: [`${SITE.url}/api/og/${ranking.benchmark}`],
    },
  };
}

function renderIntro(intro: string) {
  return intro
    .split(/\n\n+/)
    .map((para) => para.trim())
    .filter(Boolean);
}

function buildItemListJsonLd(
  ranking: RankingPage,
  pageUrl: string,
  benchmarkUrl: string,
  results: { name: string; slug: string; ms: { p50: number } }[],
  unit: string,
) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${pageUrl}#ranking`,
    name: ranking.title,
    description: ranking.metaDescription,
    url: pageUrl,
    isBasedOn: benchmarkUrl,
    numberOfItems: results.length,
    itemListOrder: "https://schema.org/ItemListOrderAscending",
    itemListElement: results.slice(0, 20).map((r, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: r.name,
      url: `${SITE.url}/products/${r.slug}`,
      description: `${r.name} — ${r.ms.p50} ${unit} (p50, 24h)`,
    })),
  };
}

export default async function RankingPageRoute({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const ranking = getRanking(slug);
  if (!ranking) return notFound();

  const benchmark = await getBenchmark(ranking.benchmark, {
    chain: ranking.chain,
  });
  if (!benchmark) return notFound();

  const pageUrl = `${SITE.url}/rankings/${ranking.slug}`;
  const benchmarkUrl = `${SITE.url}/benchmarks/${benchmark.slug}`;
  const introParas = renderIntro(ranking.intro);

  const faqJsonLd = buildFaqPageJsonLd(ranking.faq, pageUrl);
  const itemListJsonLd = buildItemListJsonLd(
    ranking,
    pageUrl,
    benchmarkUrl,
    benchmark.results,
    benchmark.unit,
  );

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE.url },
      {
        "@type": "ListItem",
        position: 2,
        name: "Rankings",
        item: `${SITE.url}/rankings`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: ranking.title,
        item: pageUrl,
      },
    ],
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListJsonLd) }}
      />
      {faqJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(faqJsonLd) }}
        />
      )}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbJsonLd) }}
      />

      <nav className="mb-6 flex items-center gap-3 text-sm text-ink-soft">
        <Link
          href="/benchmarks"
          className="inline-flex items-center gap-1 hover:text-ink"
        >
          <ArrowLeft size={14} /> All benchmarks
        </Link>
      </nav>

      <header className="mb-8 border-b border-ink/10 pb-6">
        <div className="mb-3 flex items-center gap-3">
          <LiveIndicator lastRunAt={benchmark.lastRunAt} />
          <span className="text-xs uppercase tracking-[0.16em] text-ink-faint">
            {benchmark.category}
          </span>
        </div>
        <h1 className="font-serif text-3xl leading-tight sm:text-4xl">
          {ranking.title}
        </h1>
        <p className="mt-3 max-w-3xl text-base text-ink-soft sm:text-lg">
          {ranking.subtitle}
        </p>
        <div className="mt-4 flex items-center gap-4 text-xs">
          <Link
            href={`/benchmarks/${benchmark.slug}`}
            className="inline-flex items-center gap-1 text-ink-soft hover:text-ink"
          >
            View full benchmark <ArrowUpRight size={11} />
          </Link>
          <a
            href={`${SITE.github}/tree/main/harnesses/${benchmark.slug}`}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1 text-ink-soft hover:text-ink"
          >
            Open methodology <ArrowUpRight size={11} />
          </a>
        </div>
      </header>

      <section className="prose prose-ink mb-10 max-w-3xl">
        {introParas.map((para, i) => (
          <p key={i} className="mb-4 text-ink-soft leading-relaxed">
            {para}
          </p>
        ))}
      </section>

      <section className="mb-12">
        <h2 className="mb-4 font-serif text-2xl">Live ranking</h2>
        <div className="overflow-x-auto rounded border border-ink/10">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10 bg-ink/[0.02] text-[10px] uppercase tracking-[0.12em] text-ink-faint">
              <tr>
                <th className="px-3 py-2 text-left font-medium">#</th>
                <th className="px-3 py-2 text-left font-medium">Provider</th>
                <th className="px-3 py-2 text-right font-medium">
                  p50 ({benchmark.unit})
                </th>
                <th className="px-3 py-2 text-right font-medium hidden sm:table-cell">
                  p99 ({benchmark.unit})
                </th>
                <th className="px-3 py-2 text-right font-medium hidden sm:table-cell">
                  Samples
                </th>
              </tr>
            </thead>
            <tbody>
              {benchmark.results
                .filter((r) => r.ms.p50 > 0)
                .map((r, i) => (
                  <tr
                    key={r.slug}
                    className="border-b border-ink/5 last:border-b-0"
                  >
                    <td className="px-3 py-2 font-mono text-xs text-ink-faint">
                      {i + 1}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/products/${r.slug}`}
                        className="font-medium hover:underline"
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {fmtUnit(r.ms.p50, benchmark.unit)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs hidden sm:table-cell">
                      {fmtUnit(r.ms.p99, benchmark.unit)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-ink-faint hidden sm:table-cell">
                      {r.sampleSize
                        ? Math.round(r.sampleSize).toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      {ranking.faq.length > 0 && (
        <section className="mb-12 max-w-3xl">
          <h2 className="mb-6 font-serif text-2xl">Questions</h2>
          <div className="space-y-6">
            {ranking.faq.map((item, i) => (
              <details
                key={i}
                className="group border-b border-ink/10 pb-4"
              >
                <summary className="flex cursor-pointer items-center justify-between font-medium text-ink">
                  {item.q}
                  <span className="text-ink-faint transition-transform group-open:rotate-180">
                    ▾
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </section>
      )}

      <footer className="border-t border-ink/10 pt-6 text-xs text-ink-faint">
        Data refreshes via ISR with a 60-second window. Source: the live
        Prometheus query exposed at{" "}
        <Link
          href={`/api/stat/${benchmark.slug}`}
          className="underline hover:text-ink"
        >
          /api/stat/{benchmark.slug}
        </Link>
        . Full methodology at{" "}
        <Link
          href={`/benchmarks/${benchmark.slug}`}
          className="underline hover:text-ink"
        >
          /benchmarks/{benchmark.slug}
        </Link>
        .
      </footer>
    </main>
  );
}
