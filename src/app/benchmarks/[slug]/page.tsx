import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, ChevronDown } from "lucide-react";
import {
  getBenchmark,
  getBenchmarks,
  getBenchmarkSlugs,
} from "@/data/benchmarks";
import { Pill } from "@/components/pill";
import { BenchmarkBody } from "@/components/benchmark-body";
import { LiveIndicator } from "@/components/live-indicator";
import { SectionLabel } from "@/components/summary-stat";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import { SITE } from "@/data/site";
import type { Benchmark } from "@/types/benchmark";

export const revalidate = 60;

type Params = { slug: string };

export async function generateStaticParams() {
  const slugs = await getBenchmarkSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const b = await getBenchmark(slug);
  if (!b) return {};
  const metaTitle = b.seoTitle ?? b.title;
  return {
    title: metaTitle,
    description: b.subtitle,
    openGraph: { title: metaTitle, description: b.subtitle, type: "article" },
  };
}

export default async function BenchmarkPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<{ chain?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;

  // Resolve the chain filter against what the spec actually declares.
  // When the spec declares chains, we always render scoped to one of them
  // (defaulting to the first option) — there's no aggregate view, since
  // averaging across chains rarely produces a comparable number.
  const aggregate = await getBenchmark(slug);
  if (!aggregate) notFound();
  const chainOptions = aggregate.dimensions?.chain ?? [];
  const matchedChain =
    chainOptions.find((c) => c.value === sp.chain)?.value ??
    chainOptions[0]?.value ??
    null;
  const chain = chainOptions.length > 0 ? matchedChain : null;

  // Pre-fetch every chain variant in parallel so the client can flip
  // between tabs with zero network round-trip. unstable_cache dedupes
  // each (slug, chain) combo across users so this is cheap.
  const [variantList, all] = await Promise.all([
    chainOptions.length > 0
      ? Promise.all(
          chainOptions.map(async (c) => {
            const b = await getBenchmark(slug, { chain: c.value });
            return [c.value, b ?? aggregate] as const;
          })
        )
      : Promise.resolve(
          [["__default", aggregate]] as ReadonlyArray<readonly [string, Benchmark]>
        ),
    getBenchmarks(),
  ]);
  const variants: Record<string, Benchmark> = Object.fromEntries(variantList);
  const benchmark = chain ? (variants[chain] ?? aggregate) : aggregate;

  const isDraft = benchmark.status === "draft";
  const otherBenchmarks = all.filter((b) => b.slug !== benchmark.slug);

  const catColor = CATEGORY_COLOR[benchmark.category];

  const benchmarkUrl = `${SITE.url}/benchmarks/${benchmark.slug}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: benchmark.seoTitle ?? benchmark.title,
    description: benchmark.abstract,
    url: benchmarkUrl,
    keywords: [
      benchmark.category,
      benchmark.metric,
      ...benchmark.results.map((r) => r.name),
      "live benchmark",
      "crypto infrastructure",
    ].join(", "),
    creator: { "@type": "Organization", name: "OpenChainBench", url: SITE.url },
    isAccessibleForFree: true,
    license: "https://creativecommons.org/licenses/by/4.0/",
    dateModified: benchmark.lastRunAt,
    variableMeasured: benchmark.metric,
  };

  return (
    <article className="mx-auto max-w-5xl px-6 pt-10 sm:pt-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Link
        href="/benchmarks"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        All benchmarks
      </Link>

      {/* Bench identifier — minimal mono line, no SaaS-style pills. */}
      <div className="mt-6 flex flex-wrap items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
        <span style={{ color: catColor ?? "var(--color-ink-soft)" }}>
          {benchmark.category}
        </span>
        {isDraft && <span className="text-ink-faint">draft</span>}
        {!isDraft && (
          <span className="ml-auto">
            <LiveIndicator lastRunAt={benchmark.lastRunAt} />
          </span>
        )}
      </div>

      {/* Title */}
      <h1 className="mt-5 display text-2xl sm:text-3xl md:text-4xl tracking-tight">
        {benchmark.title}
      </h1>
      <p className="mt-4 max-w-3xl text-lg sm:text-xl text-ink-soft leading-snug">
        {benchmark.subtitle}
      </p>

      {/* Body: chain tabs + summary + chart + ledger + share. Receives every
          chain variant pre-fetched server-side. flipping a tab swaps which
          variant is rendered, instantly, no network round-trip. */}
      {!isDraft && (
        <BenchmarkBody
          variants={variants}
          options={chainOptions}
          initialChain={chain ?? null}
        />
      )}

      {isDraft && <DraftNotice source={benchmark.source} />}

      {/* Findings (when present) */}
      {benchmark.findings.length > 0 && !isDraft && (
        <div className="mt-14">
          <SectionLabel>Findings</SectionLabel>
          <ol className="mt-2 space-y-4">
            {benchmark.findings.map((f, i) => (
              <li key={i} className="flex gap-4">
                <span className="font-mono text-xs tabular text-ink-faint mt-1.5 w-7 shrink-0">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <p className="text-base leading-relaxed text-ink-soft">{f}</p>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* About. collapsed by default */}
      <details className="mt-14 group border-t border-rule">
        <summary className="flex cursor-pointer items-center justify-between py-4 list-none">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink">
            About this benchmark
          </span>
          <ChevronDown
            size={16}
            strokeWidth={2}
            className="text-ink-muted transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="pb-6 space-y-6">
          <p className="text-base leading-relaxed text-ink-soft max-w-3xl">
            {benchmark.abstract}
          </p>
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint mb-3">
              Methodology
            </p>
            <ul className="space-y-2 text-sm leading-relaxed text-ink-soft">
              {benchmark.methodology.map((m) => (
                <li key={m} className="flex gap-3">
                  <span className="text-ink-faint mt-1.5">·</span>
                  <span>{m}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>

      {/* Source code link. bottom of page */}
      {!isDraft && (
        <p className="mt-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
          Source code{" "}
          <a className="lnk" href={benchmark.source}>
            {benchmark.source.replace("https://github.com/", "github.com/")}
            <ArrowUpRight size={12} strokeWidth={2} className="inline ml-1" />
          </a>
        </p>
      )}

      {/* Other benchmarks */}
      {otherBenchmarks.length > 0 && (
        <nav className="mt-20 border-t border-rule pt-8">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
            More benchmarks
          </h3>
          <ul className="mt-5 grid gap-4 sm:grid-cols-2 items-stretch">
            {otherBenchmarks.map((b) => (
              <li key={b.slug} className="flex">
                <Link
                  href={`/benchmarks/${b.slug}`}
                  className="flex-1 card-soft p-5 flex flex-col"
                >
                  <div className="flex items-center gap-2">
                    <Pill variant={b.status === "live" ? "live" : "draft"} pulse>
                      {b.status === "live" ? "Live" : "Draft"}
                    </Pill>
                    <Pill variant="category">{b.category}</Pill>
                  </div>
                  <p className="mt-3 display text-lg font-bold leading-tight">
                    {b.title}
                  </p>
                  <p className="mt-2 text-sm text-ink-muted line-clamp-2 flex-1">
                    {b.subtitle}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </article>
  );
}

function DraftNotice({ source }: { source: string }) {
  return (
    <div className="mt-10 card p-6 text-center">
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
        Draft. no live data yet
      </p>
      <p className="mt-3 text-sm text-ink-muted">
        The spec is published. Numbers will appear here as soon as the harness
        starts emitting metrics.
      </p>
      <a
        href={source}
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium lnk"
      >
        Source code
        <ArrowUpRight size={12} strokeWidth={2} />
      </a>
    </div>
  );
}
