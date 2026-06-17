import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import {
  CHAINS,
  CHAIN_BY_SLUG,
  getBenchmarksForChain,
} from "@/lib/chains";
import { fmtUnit } from "@/lib/format";
import { Breadcrumb } from "@/components/breadcrumb";
import { Pill } from "@/components/pill";
import { SITE } from "@/data/site";
import { buildBreadcrumbJsonLd, safeJsonLd } from "@/lib/jsonld";
import { capDescription } from "@/lib/seo-text";
import type { Benchmark } from "@/types/benchmark";

export const revalidate = 60;
export const maxDuration = 60;

type Params = { slug: string };

export async function generateStaticParams() {
  return CHAINS.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const chain = CHAIN_BY_SLUG.get(slug);
  if (!chain) return {};
  const benches = await getBenchmarksForChain(slug);
  const url = `${SITE.url}/chains/${slug}`;
  const title = `${chain.label} live benchmarks: finality, fees, RPC, infrastructure`;
  const description = capDescription(
    `${benches.length} live OpenChainBench measurements covering ${chain.label}. ${chain.description}`,
    158,
  );
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      type: "website",
      url,
      siteName: SITE.name,
    },
    twitter: {
      card: "summary_large_image",
      site: SITE.twitter,
      title,
      description,
    },
  };
}

function groupByCategory(
  benches: Benchmark[],
): Map<string, Benchmark[]> {
  const out = new Map<string, Benchmark[]>();
  for (const b of benches) {
    const list = out.get(b.category) ?? [];
    list.push(b);
    out.set(b.category, list);
  }
  return out;
}

export default async function ChainPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const chain = CHAIN_BY_SLUG.get(slug);
  if (!chain) notFound();
  const benches = await getBenchmarksForChain(slug);
  if (benches.length === 0) notFound();

  const byCategory = groupByCategory(benches);
  const url = `${SITE.url}/chains/${slug}`;

  // CollectionPage references every measurement on this chain as part
  // of the page's structured data. hasPart entries point back at the
  // individual /benchmarks/<slug> pages so crawlers see the cluster.
  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": `${url}#collection`,
    name: `${chain.label} live benchmarks`,
    description: chain.description,
    url,
    isPartOf: { "@id": `${SITE.url}/#site` },
    about: { "@type": "Thing", name: chain.label },
    hasPart: benches.map((b) => ({
      "@type": "Dataset",
      name: b.title,
      url: `${SITE.url}/benchmarks/${b.slug}`,
    })),
  };

  const breadcrumbLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Chains", item: `${SITE.url}/chains` },
      { name: chain.label, item: url },
    ]),
  };

  return (
    <article className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(collectionLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />

      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: "Chains", href: "/chains" },
          { label: chain.label },
        ]}
      />

      <Link
        href="/chains"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        All chains
      </Link>

      <div className="mt-6 flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
        <Pill variant="category">{chain.category}</Pill>
        <span className="sm:ml-auto font-sans tabular text-[11px] text-ink-muted">
          {benches.length} live benchmark{benches.length === 1 ? "" : "s"}
        </span>
      </div>

      <h1 className="mt-5 display text-2xl sm:text-3xl md:text-4xl tracking-tight leading-tight">
        {chain.label} live benchmarks
      </h1>

      <p className="mt-4 max-w-3xl text-base leading-relaxed text-ink-soft">
        {chain.description} Below, every OpenChainBench measurement that
        touches {chain.label}, grouped by category, with a direct link to
        the chain scoped bench page when one exists.
      </p>

      <div className="mt-12 space-y-12">
        {Array.from(byCategory.entries()).map(([category, list]) => (
          <section key={category}>
            <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
              {category}
            </h2>
            <ul className="mt-4 divide-y divide-rule border-y border-rule">
              {list.map((b) => {
                const ownResult = b.results.find((r) => r.slug === slug);
                const chainOption = b.dimensions?.chain?.find(
                  (c) => c.value === slug,
                );
                const hasChainRoute =
                  (b.perChainExplainer ?? []).some((e) => e.slug === slug);
                const href = hasChainRoute
                  ? `/benchmarks/${b.slug}/${slug}`
                  : `/benchmarks/${b.slug}`;
                const showOwnValue =
                  ownResult && ownResult.ms.p50 > 0;
                return (
                  <li key={b.slug}>
                    <Link
                      href={href}
                      className="group flex items-center justify-between gap-4 py-3 hover:bg-surface transition-colors"
                    >
                      <span className="min-w-0">
                        <span className="block text-base text-ink-soft group-hover:text-ink">
                          {b.title}
                        </span>
                        {showOwnValue && (
                          <span className="mt-0.5 block text-[11px] text-ink-faint tabular">
                            {chain.label}: {fmtUnit(ownResult.ms.p50, b.unit)}{" "}
                            p50 ({b.metric})
                          </span>
                        )}
                        {!showOwnValue && chainOption && (
                          <span className="mt-0.5 block text-[11px] text-ink-faint">
                            {chain.label} is a filter dimension on this bench
                          </span>
                        )}
                      </span>
                      <ArrowUpRight
                        size={14}
                        strokeWidth={2}
                        className="text-ink-faint group-hover:text-ink shrink-0"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-12 max-w-2xl text-xs text-ink-muted">
        Every metric is reproducible from the{" "}
        <Link href="/methodology" className="lnk">
          methodology
        </Link>{" "}
        and the open harness source. Numbers refresh within 60 seconds of
        each measurement.
      </p>
    </article>
  );
}
