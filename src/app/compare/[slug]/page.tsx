import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { getProvider } from "@/lib/providers";
import {
  getComparePair,
  getComparePairSlugs,
  type ComparePair,
} from "@/data/compare-pairs";
import { getProviderRegistry } from "@/data/provider-registry";
import { ProviderLogo } from "@/components/provider-logo";
import { fmtUnit } from "@/lib/format";
import { capDescription } from "@/lib/seo-text";
import { safeJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

/**
 * Compare pages reuse the parent benchmarks' Prom data, so freshness
 * inherits 1:1 from the underlying benches. ISR window matches the
 * /products/[slug] page because the same provider appearances back both.
 */
export const revalidate = 60;
export const maxDuration = 60;

type Params = { slug: string };

export async function generateStaticParams() {
  return getComparePairSlugs().map((slug) => ({ slug }));
}

async function loadPairProviders(pair: ComparePair) {
  const [a, b] = await Promise.all([
    getProvider(pair.providerA),
    getProvider(pair.providerB),
  ]);
  return { a, b };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const pair = getComparePair(slug);
  if (!pair) return {};
  const { a, b } = await loadPairProviders(pair);
  if (!a || !b) return {};

  const url = `${SITE.url}/compare/${pair.slug}`;
  const title = `${a.name} vs ${b.name}: live OpenChainBench benchmark data`;
  const description = capDescription(
    `${a.name} vs ${b.name} side by side on every shared OpenChainBench benchmark. Live measurements, identical layout, no verdict.`,
    158,
  );

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      // "website" matches the Dataset positioning in JSON-LD. "article"
      // would announce editorial framing on FB/X cards, which collapses
      // the anti-verdict execution this whole route is built around.
      type: "website",
      siteName: SITE.name,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      site: SITE.twitter,
    },
  };
}

type SharedBench = {
  slug: string;
  title: string;
  category: string;
  unit: string;
  higherIsBetter: boolean;
  lastRunAt?: string;
  aResult: {
    rank: number;
    p50: number;
    p99: number;
    sampleSize?: number;
  };
  bResult: {
    rank: number;
    p50: number;
    p99: number;
    sampleSize?: number;
  };
};

function intersectAppearances(
  pair: ComparePair,
  aAppearances: Awaited<ReturnType<typeof getProvider>>,
  bAppearances: Awaited<ReturnType<typeof getProvider>>,
): SharedBench[] {
  if (!aAppearances || !bAppearances) return [];

  const aByBench = new Map(
    aAppearances.appearances.map((x) => [x.benchmark.slug, x] as const),
  );
  const bByBench = new Map(
    bAppearances.appearances.map((x) => [x.benchmark.slug, x] as const),
  );

  // If the pair explicitly pinned benchmarks we respect that list,
  // otherwise we take the natural intersection.
  const sharedSlugs = pair.benchmarks
    ? pair.benchmarks.filter((s) => aByBench.has(s) && bByBench.has(s))
    : Array.from(aByBench.keys()).filter((s) => bByBench.has(s));

  const out: SharedBench[] = [];
  for (const benchSlug of sharedSlugs) {
    const a = aByBench.get(benchSlug);
    const b = bByBench.get(benchSlug);
    if (!a || !b) continue;
    out.push({
      slug: a.benchmark.slug,
      title: a.benchmark.title,
      category: a.benchmark.category,
      unit: a.benchmark.unit,
      higherIsBetter: a.benchmark.higherIsBetter === true,
      lastRunAt: a.benchmark.lastRunAt,
      aResult: {
        rank: a.rank,
        p50: a.result.ms.p50,
        p99: a.result.ms.p99,
        sampleSize: a.result.sampleSize,
      },
      bResult: {
        rank: b.rank,
        p50: b.result.ms.p50,
        p99: b.result.ms.p99,
        sampleSize: b.result.sampleSize,
      },
    });
  }
  return out;
}

function fmtTs(iso?: string): string | null {
  if (!iso) return null;
  return new Date(iso).toUTCString().replace("GMT", "UTC");
}

export default async function ComparePage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const pair = getComparePair(slug);
  if (!pair) return notFound();

  const { a, b } = await loadPairProviders(pair);
  if (!a || !b) return notFound();

  const shared = intersectAppearances(pair, a, b);
  if (shared.length === 0) return notFound();

  const regA = getProviderRegistry(a.slug);
  const regB = getProviderRegistry(b.slug);

  const url = `${SITE.url}/compare/${pair.slug}`;
  const latestTs = shared.reduce<string | null>((acc, s) => {
    if (!s.lastRunAt) return acc;
    if (!acc || new Date(s.lastRunAt) > new Date(acc)) return s.lastRunAt;
    return acc;
  }, null);

  // Dataset JSON-LD is the right shape for compare pages. The page is a
  // dataset of paired measurements, not an editorial article. Dataset
  // also surfaces in Google's Dataset Search. We intentionally do NOT
  // embed rankings or a winner field in the schema.
  const datasetJsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${url}#dataset`,
    name: `${a.name} vs ${b.name} OpenChainBench measurements`,
    description: `Side by side live measurements for ${a.name} and ${b.name} on ${shared.length} shared OpenChainBench benchmarks.`,
    url,
    creator: { "@id": `${SITE.url}/#org` },
    license: "https://creativecommons.org/licenses/by/4.0/",
    measurementTechnique: `${SITE.url}/methodology`,
    variableMeasured: shared.map((s) => ({
      "@type": "PropertyValue",
      name: s.title,
      unitText: s.unit,
    })),
    isBasedOn: shared.map((s) => `${SITE.url}/benchmarks/${s.slug}`),
    distribution: shared.map((s) => ({
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${SITE.url}/api/stat/${s.slug}`,
    })),
    ...(latestTs ? { dateModified: latestTs } : {}),
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE.url },
      {
        "@type": "ListItem",
        position: 2,
        name: "Compare",
        item: `${SITE.url}/compare`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: `${a.name} vs ${b.name}`,
        item: url,
      },
    ],
  };

  return (
    <main className="mx-auto max-w-5xl px-6 pt-10 pb-16 sm:pt-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(datasetJsonLd) }}
      />
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

      <header className="border-b-2 border-ink pb-6">
        <h1 className="display text-3xl tracking-tight sm:text-4xl">
          {a.name} vs {b.name}
        </h1>
        <p className="mt-3 max-w-2xl text-base text-ink-soft">
          Side by side OpenChainBench measurements. Identical layout for
          both providers, no editorial verdict, no winner badge. The
          numbers below come straight from the same Prometheus queries
          that drive the parent benchmark pages.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-ink-muted">
          <Link
            href="/methodology"
            className="inline-flex items-center gap-1 hover:text-ink"
          >
            Read methodology <ArrowUpRight size={11} />
          </Link>
          {latestTs && (
            <span>
              Last measured{" "}
              <time
                dateTime={new Date(latestTs).toISOString()}
                className="text-ink-soft"
              >
                {fmtTs(latestTs)}
              </time>
            </span>
          )}
          <span>Window: rolling 24h</span>
          <span>{shared.length} shared {shared.length === 1 ? "benchmark" : "benchmarks"}</span>
        </div>
      </header>

      <section className="mt-8 grid grid-cols-2 gap-4 sm:gap-6">
        <div className="flex items-center gap-3 border border-rule p-4">
          <ProviderLogo slug={a.slug} name={a.name} size={40} />
          <div className="min-w-0">
            <Link
              href={`/products/${a.slug}`}
              className="font-medium hover:underline"
            >
              {a.name}
            </Link>
            {regA?.description && (
              <p className="mt-0.5 text-[11px] text-ink-muted leading-snug line-clamp-2">
                {regA.description}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 border border-rule p-4">
          <ProviderLogo slug={b.slug} name={b.name} size={40} />
          <div className="min-w-0">
            <Link
              href={`/products/${b.slug}`}
              className="font-medium hover:underline"
            >
              {b.name}
            </Link>
            {regB?.description && (
              <p className="mt-0.5 text-[11px] text-ink-muted leading-snug line-clamp-2">
                {regB.description}
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          Side by side measurements
        </h2>
        <div className="mt-4 space-y-6">
          {shared.map((s) => (
            <article
              key={s.slug}
              className="border border-rule px-4 py-5 sm:px-6 sm:py-6"
            >
              <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-serif text-lg">
                  <Link
                    href={`/benchmarks/${s.slug}`}
                    className="hover:underline"
                  >
                    {s.title}
                  </Link>
                </h3>
                <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                  {s.category}
                </span>
              </header>
              <div className="grid grid-cols-2 gap-4 sm:gap-6">
                <BenchPanel
                  providerName={a.name}
                  rank={s.aResult.rank}
                  p50={s.aResult.p50}
                  p99={s.aResult.p99}
                  unit={s.unit}
                  sampleSize={s.aResult.sampleSize}
                />
                <BenchPanel
                  providerName={b.name}
                  rank={s.bResult.rank}
                  p50={s.bResult.p50}
                  p99={s.bResult.p99}
                  unit={s.unit}
                  sampleSize={s.bResult.sampleSize}
                />
              </div>
              <footer className="mt-4 text-[10px] text-ink-faint">
                Rolling 24h.{" "}
                <Link
                  href={`/api/stat/${s.slug}`}
                  className="underline hover:text-ink-soft"
                >
                  Raw data
                </Link>
              </footer>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-12 max-w-3xl">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          How this pair was selected
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          A pair is published when all four conditions hold. Both
          providers run in the same OpenChainBench benchmark for at
          least seven consecutive days. Each provider has at least 1000
          samples in the measurement window. The head to head query has
          observable third party search demand. Both providers have a
          public <code>/products/[slug]</code> page on OCB. The full
          pair ledger is versioned in the public repo so the
          methodology is externally verifiable.
        </p>
      </section>

      <footer className="mt-12 border-t border-rule pt-6 text-xs text-ink-muted">
        Live data refreshes via ISR within 60 seconds of a new run.
        Sources are the same Prometheus queries surfaced on the parent
        benchmark pages.
      </footer>
    </main>
  );
}

function BenchPanel({
  providerName,
  rank,
  p50,
  p99,
  unit,
  sampleSize,
}: {
  providerName: string;
  rank: number;
  p50: number;
  p99: number;
  unit: string;
  sampleSize?: number;
}) {
  const hasData = rank > 0 && p50 > 0;
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
        {providerName}
      </p>
      {hasData ? (
        <>
          <p className="mt-1 font-serif text-2xl tabular-nums">
            {fmtUnit(p50, unit)}
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-ink-muted tabular-nums">
            <dt>p99</dt>
            <dd className="text-right">{fmtUnit(p99, unit)}</dd>
            <dt>rank</dt>
            <dd className="text-right">#{rank}</dd>
            {sampleSize ? (
              <>
                <dt>samples</dt>
                <dd className="text-right">
                  {Math.round(sampleSize).toLocaleString()}
                </dd>
              </>
            ) : null}
          </dl>
        </>
      ) : (
        <p className="mt-1 text-sm text-ink-faint">No data in window</p>
      )}
    </div>
  );
}
