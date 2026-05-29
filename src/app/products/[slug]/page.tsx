import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { getProvider, getProviderSlugs } from "@/lib/providers";
import { ProviderLogo } from "@/components/provider-logo";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import { fmtUnit } from "@/lib/format";
import { SITE } from "@/data/site";
import {
  getProviderRegistry,
  PROVIDER_REGISTRY,
} from "@/data/provider-registry";
import { safeJsonLd } from "@/lib/jsonld";

export const revalidate = 60;

type Params = { slug: string };

export async function generateStaticParams() {
  const slugs = await getProviderSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const p = await getProvider(slug);
  if (!p) return {};
  const reg = getProviderRegistry(p.slug);
  const title = `${p.name} benchmark record`;
  const description =
    reg?.description ??
    `Every OpenChainBench result for ${p.name}. Tracked across ${p.appearances.length} ${p.appearances.length === 1 ? "benchmark" : "benchmarks"}, ${p.wins} #1 ${p.wins === 1 ? "finish" : "finishes"}.`;
  const url = `${SITE.url}/products/${p.slug}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, type: "profile", url },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function ProviderPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const p = await getProvider(slug);
  if (!p) notFound();
  const reg = getProviderRegistry(p.slug);

  const sorted = [...p.appearances].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.benchmark.title.localeCompare(b.benchmark.title);
  });

  const url = `${SITE.url}/products/${p.slug}`;
  const sameAs: string[] = [];
  if (reg?.url) sameAs.push(reg.url);
  if (reg?.twitter) {
    sameAs.push(`https://twitter.com/${reg.twitter.replace(/^@/, "")}`);
  }
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: p.name,
        url: reg?.url ?? url,
        identifier: p.slug,
        description:
          reg?.description ??
          `Crypto-infrastructure provider tracked by OpenChainBench across ${p.appearances.length} live benchmarks.`,
        ...(sameAs.length > 0 ? { sameAs } : {}),
        subjectOf: sorted.map((a) => ({
          "@type": "Dataset",
          name: a.benchmark.title,
          description: a.benchmark.subtitle,
          url: `${SITE.url}/benchmarks/${a.benchmark.slug}`,
          creator: { "@id": `${SITE.url}/#org` },
          license: "https://creativecommons.org/licenses/by/4.0/",
        })),
      },
      {
        "@type": "SoftwareApplication",
        name: p.name,
        identifier: p.slug,
        url,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Cross-platform",
        description:
          reg?.description ??
          `${p.name} is a crypto-infrastructure product measured by OpenChainBench across ${p.appearances.length} live benchmarks.`,
        ...(reg?.url ? { downloadUrl: reg.url } : {}),
        ...(sameAs.length > 0 ? { sameAs } : {}),
        creator: { "@id": `${SITE.url}/#org` },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Home",
            item: SITE.url,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: "Products",
            item: `${SITE.url}/products`,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: p.name,
            item: url,
          },
        ],
      },
    ],
  };

  return (
    <article className="mx-auto max-w-5xl px-6 pt-10 sm:pt-14 pb-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/products"
          className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          All products
        </Link>
      </div>

      {(() => {
        // Brand-family cross-link: surface a "Part of <parent>" badge when
        // this entry is a sub-product, and a "Related products" list on
        // the parent page enumerating its declared children. Computed
        // once near the header so the JSX below only renders if non-empty.
        const parentSlug = reg?.parent;
        const parentReg = parentSlug ? getProviderRegistry(parentSlug) : undefined;
        const children = Object.entries(PROVIDER_REGISTRY)
          .filter(([childSlug, e]) => e.parent === p.slug && childSlug !== p.slug)
          .map(([childSlug, e]) => ({ slug: childSlug, name: e.description.split(".")[0] || childSlug }));
        return (
          <>
            <header className="mt-6 flex items-center gap-4 border-b-2 border-ink pb-6">
              <ProviderLogo slug={p.slug} name={p.name} size={56} />
              <div className="min-w-0">
                <h1 className="display text-2xl sm:text-3xl md:text-4xl tracking-tight">
                  {p.name}
                </h1>
                <p className="mt-2 font-sans text-[11px] uppercase tracking-[0.18em] text-ink-muted font-medium">
                  {p.appearances.length} {p.appearances.length === 1 ? "benchmark" : "benchmarks"}
                  {p.wins > 0 && (
                    <>
                      <span className="text-ink-faint"> · </span>
                      <span className="text-good">{p.wins} #1 {p.wins === 1 ? "finish" : "finishes"}</span>
                    </>
                  )}
                  {p.type && (
                    <>
                      <span className="text-ink-faint"> · </span>
                      <span>{p.type}</span>
                    </>
                  )}
                  {parentSlug && parentReg && (
                    <>
                      <span className="text-ink-faint"> · </span>
                      <Link
                        href={`/products/${parentSlug}`}
                        className="hover:text-ink transition-colors underline underline-offset-2 decoration-rule"
                      >
                        Part of {parentSlug}
                      </Link>
                    </>
                  )}
                </p>
              </div>
            </header>
            {children.length > 0 && (
              <p className="mt-6 text-sm text-ink-muted">
                Related {p.name} products:{" "}
                {children.map((c, i) => (
                  <span key={c.slug}>
                    {i > 0 && <span className="text-ink-faint"> · </span>}
                    <Link href={`/products/${c.slug}`} className="lnk">
                      {c.slug}
                    </Link>
                  </span>
                ))}
              </p>
            )}
          </>
        );
      })()}

      {reg && (
        <section className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-8">
          <p className="text-base text-ink-soft leading-relaxed max-w-2xl">
            {reg.description}
          </p>
          <ul className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-4 sm:gap-y-1 sm:ml-auto sm:flex-col sm:items-end sm:text-right shrink-0 min-w-0">
            <li className="min-w-0">
              <a
                className="lnk inline-flex items-center gap-1 font-sans text-[11px] uppercase tracking-[0.16em] font-medium text-ink-soft hover:text-ink break-all"
                href={reg.url}
                rel="noopener"
              >
                {reg.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                <ArrowUpRight size={11} strokeWidth={2} className="shrink-0" />
              </a>
            </li>
            {reg.twitter && (
              <li>
                <a
                  className="lnk inline-flex items-center gap-1 font-sans text-[11px] uppercase tracking-[0.16em] font-medium text-ink-soft hover:text-ink"
                  href={`https://twitter.com/${reg.twitter.replace(/^@/, "")}`}
                  rel="noopener"
                >
                  {reg.twitter}
                  <ArrowUpRight size={11} strokeWidth={2} />
                </a>
              </li>
            )}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          Benchmark record
        </h2>
        <ol className="mt-4 divide-y divide-rule border-y border-rule">
          {sorted.map((a) => {
            const catColor = CATEGORY_COLOR[a.benchmark.category];
            const hasData = a.rank > 0 && a.result.ms.p50 > 0;
            const value = hasData ? fmtUnit(a.result.ms.p50, a.benchmark.unit) : null;
            // Per-chain rank chips. Rendered alongside the aggregate rank
            // when the bench declares chain dimensions and the provider has
            // per-chain ranks populated. Surface text reads e.g. "#1 on
            // Solana · #4 on Base · #4 on BNB" so a chain-restricted
            // provider can't be passed off as a free cross-chain #1.
            const chainRanks =
              a.rankPerChain && a.benchmark.chainDimensions
                ? a.benchmark.chainDimensions
                    .filter((c) => c.value !== "all")
                    .map((c) => ({ chain: c, entry: a.rankPerChain?.[c.value] }))
                    .filter(
                      (
                        x,
                      ): x is {
                        chain: { value: string; label: string };
                        entry: { rank: number; totalRanked: number };
                      } => !!x.entry,
                    )
                : [];
            const hasChainRanks = chainRanks.length > 0;
            return (
              <li key={a.benchmark.slug}>
                <Link
                  href={`/benchmarks/${a.benchmark.slug}`}
                  className="group grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto] items-start sm:items-center gap-x-4 gap-y-2 py-5 pl-3 pr-3 hover:bg-paper-soft/60 transition-colors"
                >
                  <span
                    className="font-sans tabular text-xl sm:text-2xl font-semibold w-12 text-center"
                    style={{ color: a.rank === 1 ? "var(--color-good)" : "var(--color-ink-soft)" }}
                  >
                    {hasData ? (
                      <>
                        #{a.rank}
                        <span className="block text-[9px] uppercase tracking-[0.16em] text-ink-faint mt-0.5">
                          of {a.totalRanked}
                        </span>
                      </>
                    ) : (
                      <span className="block text-[10px] uppercase tracking-[0.16em] text-ink-faint italic font-normal">
                        awaiting
                      </span>
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="font-sans text-[10px] uppercase tracking-[0.18em] font-medium" style={{ color: catColor ?? "var(--color-ink-faint)" }}>
                      {a.benchmark.category}
                    </p>
                    <h3 className="mt-0.5 display text-base sm:text-lg font-semibold leading-tight truncate">
                      {a.benchmark.title}
                    </h3>
                    <p className="text-xs text-ink-muted truncate">
                      {a.benchmark.metric}
                    </p>
                    {hasChainRanks && (
                      <p className="mt-1.5 flex flex-wrap items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.14em] font-medium">
                        {chainRanks.map(({ chain, entry }) => (
                          <span
                            key={chain.value}
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                              entry.rank === 1
                                ? "border-good/40 bg-good/10 text-good"
                                : "border-rule bg-paper-soft text-ink-muted"
                            }`}
                          >
                            #{entry.rank} on {chain.label}
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                  <div className="col-start-2 sm:col-start-3 text-left sm:text-right">
                    {hasData ? (
                      <>
                        <p className="font-sans tabular text-base text-ink">{value}</p>
                        <p className="font-sans text-[9px] uppercase tracking-[0.16em] text-ink-faint mt-0.5 font-medium">
                          p50 · 24h
                        </p>
                      </>
                    ) : (
                      <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint italic font-medium">
                        data warming up
                      </p>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      </section>

      {p.wins > 0 && (
        <section className="mt-12">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
            Embeddable badges
          </h2>
          <p className="mt-2 text-sm text-ink-soft leading-snug max-w-2xl">
            Drop these on your site to show your standing on a benchmark.
            The SVG fetches the latest figures on every request, so the badge
            stays accurate without redeploying.
          </p>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {sorted.filter((a) => a.rank === 1).map((a) => {
              const badgeUrl = `${SITE.url}/api/badge/${a.benchmark.slug}/${p.slug}`;
              const targetUrl = `${SITE.url}/benchmarks/${a.benchmark.slug}`;
              const html = `<a href="${targetUrl}"><img src="${badgeUrl}" alt="Ranked #1 on OpenChainBench: ${a.benchmark.title}" height="36" /></a>`;
              return (
                <li key={`badge-${a.benchmark.slug}`} className="card-soft p-4">
                  <p className="text-xs font-sans font-medium uppercase tracking-[0.18em] text-ink-muted">
                    {a.benchmark.title}
                  </p>
                  <div className="mt-3 flex items-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={badgeUrl}
                      alt={`Ranked #1 on OpenChainBench: ${a.benchmark.title}`}
                      height={36}
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[11px] font-sans font-medium uppercase tracking-[0.18em] text-ink-muted hover:text-ink">
                      Copy HTML
                    </summary>
                    <pre className="mt-2 overflow-x-auto rounded border border-rule bg-paper-soft p-2 text-[11px] leading-snug">
{html}
                    </pre>
                  </details>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p className="mt-12 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
        Raw figures{" "}
        <a className="lnk" href={`${SITE.url}/api/citable`}>
          /api/citable
          <ArrowUpRight size={12} strokeWidth={2} className="inline ml-1" />
        </a>
      </p>
    </article>
  );
}
