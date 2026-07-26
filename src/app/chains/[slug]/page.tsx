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
import {
  fetchChainKpis,
  fetchChainTvlFullHistory,
  hasAnyKpi,
} from "@/lib/chain-kpis";
import { ChainKpiStrip } from "@/components/chain-kpi-strip";
import { ChainRpcSection } from "@/components/chain-rpc-section";
import {
  VenueKpiToggle,
  type VenueToggleSection,
} from "@/components/venue-kpi-toggle";
import { getRpcChainRow } from "@/lib/rpc-hub-stats";
import { Breadcrumb } from "@/components/breadcrumb";
import { Pill } from "@/components/pill";
import { ProviderLogo } from "@/components/provider-logo";
import { SITE } from "@/data/site";
import { buildBreadcrumbJsonLd, safeJsonLd } from "@/lib/jsonld";
import { capDescription } from "@/lib/seo-text";
import { matchesChainSlug } from "@/lib/chain-aliases";
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
  const title = `${chain.label} live benchmarks: finality, fees, RPC`;
  const description = capDescription(
    `${benches.length} live OpenChainBench measurement${benches.length === 1 ? "" : "s"} covering ${chain.label}. ${chain.description}`,
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

  // KPI strip data flows from the `chain-kpis` harness on Railway.
  // A null return (Prom unreachable, chain has no published series)
  // hides the strip silently; the benches list below still renders.
  // TVL full history is fetched directly from DefiLlama (single ~50 KB
  // call, revalidated every 15 min). Client renders the active range
  // (7D/30D/90D/1Y/All) without extra network round-trips.
  const [kpis, tvlHistory, rpcRow] = await Promise.all([
    fetchChainKpis(slug),
    fetchChainTvlFullHistory(slug),
    getRpcChainRow(slug),
  ]);

  const byCategory = groupByCategory(benches);
  const url = `${SITE.url}/chains/${slug}`;

  // KPI domain pill bar (same pattern as /products/<slug>): the existing
  // Live KPIs strip (including the TVL chart) becomes the "Chain KPIs"
  // section, and chains covered by a <chain>-rpc bench gain an "RPC"
  // section. Chains without a hub row keep a single "Chain KPIs" pill;
  // the strip's own gating (kpis && hasAnyKpi) is unchanged.
  const kpiSections: VenueToggleSection[] = [];
  if (kpis && hasAnyKpi(kpis)) {
    kpiSections.push({
      id: "chain-kpis",
      label: "Chain KPIs",
      content: (
        <div className="mt-6">
          <ChainKpiStrip
            slug={slug}
            kpis={kpis}
            nativeSymbol={chain.nativeSymbol}
            tvlHistory={tvlHistory}
            chainLabel={chain.label}
          />
        </div>
      ),
    });
  }
  if (rpcRow) {
    kpiSections.push({
      id: "rpc",
      label: "RPC",
      content: <ChainRpcSection chainSlug={slug} />,
    });
  }

  // ItemList of Datasets, one entry per benchmark that touches this chain.
  // Previously CollectionPage — Google's rich result validator doesn't
  // recognise CollectionPage as a supported type and flagged every chain
  // hub. ItemList is a documented Google rich result target and carries
  // the same cluster signal (each item links back to /benchmarks/<slug>).
  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${url}#datasets`,
    name: `${chain.label} live benchmarks`,
    description: chain.description,
    url,
    numberOfItems: benches.length,
    itemListElement: benches.map((b, i) => ({
      "@type": "ListItem",
      position: i + 1,
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

      <header className="mt-5 flex items-center gap-4">
        <ProviderLogo slug={chain.slug} name={chain.label} size={56} />
        <h1 className="display text-2xl sm:text-3xl md:text-4xl tracking-tight leading-tight">
          {chain.label} live benchmarks
        </h1>
      </header>

      <p className="mt-4 max-w-3xl text-base leading-relaxed text-ink-soft">
        {chain.description} Below, every OpenChainBench measurement that
        touches {chain.label}, grouped by category, with a direct link to
        the chain scoped bench page when one exists.
      </p>

      <VenueKpiToggle sections={kpiSections} />

      <div className="mt-12 space-y-12">
        {Array.from(byCategory.entries()).map(([category, list]) => (
          <section key={category}>
            <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
              {category}
            </h2>
            <ul className="mt-4 divide-y divide-rule border-y border-rule">
              {list.map((b) => {
                // Canonical-aware matches: the bench's results / dimensions /
                // perChainExplainer might still carry the legacy slug ("ton")
                // while the URL is the renamed "gram". The matcher resolves
                // both sides to the canonical chain so all three lookups land.
                const ownResult = b.results.find((r) =>
                  matchesChainSlug(r.slug, slug),
                );
                const chainOption = b.dimensions?.chain?.find((c) =>
                  matchesChainSlug(c.value, slug),
                );
                const hasChainRoute = (b.perChainExplainer ?? []).some((e) =>
                  matchesChainSlug(e.slug, slug),
                );
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
