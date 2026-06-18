import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { getBenchmark } from "@/data/benchmarks";
import { Breadcrumb } from "@/components/breadcrumb";
import { liveResults } from "@/lib/provider-filters";
import { rankResults } from "@/lib/ranking";
import { fmtUnit } from "@/lib/format";
import { capDescription, stripInlineMarkdown } from "@/lib/seo-text";
import { SITE } from "@/data/site";
import { pageMetadata } from "@/lib/page-metadata";
import { buildBreadcrumbJsonLd, safeJsonLd } from "@/lib/jsonld";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import type { Benchmark, ProviderResult } from "@/types/benchmark";

// Dedicated per-chain landing pages. Only chains that have a hand-written
// `per_chain_explainer` entry in the bench YAML get a route here - that
// unique editorial body is what keeps these pages from being doorway
// duplicates of the parent bench. The parent's `?chain=` query filter
// stays a client-side UI affordance; THIS route is the indexable,
// self-canonical document targeting long-tail queries like "ethereum
// finality time" or "fastest free polygon rpc".
//
// Two bench shapes resolve here:
//   - "row":       the chain IS a leaderboard row (l1-finality, where
//                  results are chains). Page shows the chain's measured
//                  value + rank against sibling chains.
//   - "dimension": the chain is a filter dimension (rpc-capabilities,
//                  where results are providers probed per chain). Page
//                  shows the provider leaderboard scoped to that chain,
//                  with per-region leaders called out when they differ -
//                  a provider that wins on 6 of 10 chains in one region
//                  must never be presented as the global winner.
export const revalidate = 60;

// Dimension pages fan out to (chain x region) variant fetches; a cold
// render can take a while when the unstable_cache is empty.
export const maxDuration = 300;

type Params = { slug: string; chain: string };

function explainerChains(b: Benchmark): string[] {
  const resultSlugs = new Set(b.results.map((r) => r.slug));
  const chainValues = new Set(
    (b.dimensions?.chain ?? [])
      .map((c) => c.value)
      .filter((v) => v.toLowerCase() !== "all"),
  );
  return (b.perChainExplainer ?? [])
    .map((e) => e.slug)
    .filter((s) => resultSlugs.has(s) || chainValues.has(s));
}

// Rendered ON DEMAND, like product pages and OG images. Even the
// "cheap" row-shaped pages turned out not to be free at build: the
// catalog payload is >2MB so unstable_cache refuses to store it, every
// page reloads the full catalog, and chain pages took 240s+ in failed
// builds. No Prom calls at build; pages warm via ISR + sitemap crawl.
export async function generateStaticParams() {
  return [];
}

type Explainer = { slug: string; h2: string; body: string };

type RowShape = {
  shape: "row";
  benchmark: Benchmark;
  explainer: Explainer;
  result: ProviderResult;
  sorted: ProviderResult[];
  rank: number;
};

type DimensionShape = {
  shape: "dimension";
  benchmark: Benchmark;
  explainer: Explainer;
  chainLabel: string;
  providers: ProviderResult[];
  leader: ProviderResult | null;
  regionLeaders: { region: string; leader: ProviderResult }[];
};

type ChainPageData = RowShape | DimensionShape;

/** The spec loader's renderTemplate only resolves placeholders for
 *  providers that are "live" this cycle. When data is in a transient
 *  gap, raw `{{p50:ethereum}}` / `{{best_name:chain:base}}` tokens
 *  would leak into the H1 copy and the meta description. Resolve what
 *  we can against the full results array, degrade the rest to neutral
 *  copy so template syntax never ships to the SERP. */
function resolveLeftoverPlaceholders(text: string, b: Benchmark): string {
  return text
    .replace(
      /\{\{\s*(p50|p90|p99|mean|name):([a-z0-9-]+)\s*\}\}/gi,
      (whole, keyword: string, slug: string) => {
        const row = b.results.find(
          (r) => r.slug.toLowerCase() === slug.toLowerCase(),
        );
        const k = keyword.toLowerCase();
        if (k === "name") return row ? row.name : whole;
        const raw = row?.ms[k as "p50" | "p90" | "p99" | "mean"];
        if (!raw || raw <= 0) return "measured live";
        return fmtUnit(raw, b.unit);
      },
    )
    .replace(/\{\{\s*(best_name|worst_name):chain:[a-z0-9_-]+\s*\}\}/gi, "the live leader")
    .replace(/\{\{\s*(best_p50|worst_p50):chain:[a-z0-9_-]+\s*\}\}/gi, "measured live");
}

function sortLive(results: ProviderResult[], higherIsBetter: boolean) {
  return rankResults(liveResults(results), higherIsBetter);
}

async function loadChainPage(
  slug: string,
  chain: string,
): Promise<ChainPageData | null> {
  const benchmark = await getBenchmark(slug);
  if (!benchmark) return null;
  const found = (benchmark.perChainExplainer ?? []).find(
    (e) => e.slug === chain,
  );
  if (!found) return null;
  const explainer = {
    ...found,
    h2: resolveLeftoverPlaceholders(found.h2, benchmark),
    body: resolveLeftoverPlaceholders(found.body, benchmark),
  };

  // Shape 1: the chain is a leaderboard row (l1-finality).
  const result = benchmark.results.find((r) => r.slug === chain);
  if (result) {
    const sorted = sortLive(benchmark.results, benchmark.higherIsBetter);
    const rank = sorted.findIndex((r) => r.slug === chain) + 1;
    return { shape: "row", benchmark, explainer, result, sorted, rank };
  }

  // Shape 2: the chain is a filter dimension (rpc-capabilities).
  const chainOption = (benchmark.dimensions?.chain ?? []).find(
    (c) => c.value === chain && c.value.toLowerCase() !== "all",
  );
  if (!chainOption) return null;
  const scoped = (await getBenchmark(slug, { chain })) ?? benchmark;
  const providers = sortLive(scoped.results, benchmark.higherIsBetter);
  const leader = providers[0] ?? null;

  // Per-region leaders on this chain. The cross-region scoped leaderboard
  // is the headline, but when regional winners diverge the key-facts line
  // says so explicitly instead of crowning one provider globally.
  const regions = (benchmark.dimensions?.region ?? []).filter(
    (r) => r.value.toLowerCase() !== "all",
  );
  const regionLeaders: { region: string; leader: ProviderResult }[] = [];
  if (regions.length > 0) {
    const variants = await Promise.all(
      regions.map(async (r) => ({
        label: r.label,
        bench: await getBenchmark(slug, { chain, region: r.value }),
      })),
    );
    for (const v of variants) {
      if (!v.bench) continue;
      const lead = sortLive(v.bench.results, benchmark.higherIsBetter)[0];
      if (lead) regionLeaders.push({ region: v.label, leader: lead });
    }
  }

  return {
    shape: "dimension",
    benchmark,
    explainer,
    chainLabel: chainOption.label,
    providers,
    leader,
    regionLeaders,
  };
}

function asOfDate(lastRunAt: string | undefined): string {
  const d = lastRunAt ? new Date(lastRunAt) : new Date();
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** "dRPC in US-East and EU-West; PublicNode in Singapore." Groups
 *  regions by their leading provider, preserving region order. */
function regionLeaderSentence(
  regionLeaders: { region: string; leader: ProviderResult }[],
): string | null {
  if (regionLeaders.length < 2) return null;
  const names = new Set(regionLeaders.map((r) => r.leader.name));
  if (names.size === 1) {
    return `${regionLeaders[0].leader.name} leads in all ${regionLeaders.length} regions measured.`;
  }
  const byLeader = new Map<string, string[]>();
  for (const r of regionLeaders) {
    const list = byLeader.get(r.leader.name) ?? [];
    list.push(r.region);
    byLeader.set(r.leader.name, list);
  }
  const parts = [...byLeader.entries()].map(
    ([name, regions]) => `${name} in ${regions.join(" and ")}`,
  );
  return `Regional leaders differ: ${parts.join("; ")}.`;
}

/** Mid-sentence metric phrase: "Finality time" -> "finality time" but
 *  "RPC latency" stays as-is (leading acronym must not become "rpc"). */
function metricPhrase(metric: string): string {
  return /^[A-Z]{2}/.test(metric)
    ? metric
    : metric.charAt(0).toLowerCase() + metric.slice(1);
}

function buildKeyFacts(data: ChainPageData): string {
  const b = data.benchmark;
  const date = asOfDate(b.lastRunAt);
  if (data.shape === "row") {
    const { result, sorted, rank } = data;
    const subject = `${result.name} ${metricPhrase(b.metric)}`;
    if (result.ms.p50 <= 0) {
      return `${subject} is measured continuously on this benchmark. Live numbers will appear here as soon as the harness reports fresh samples.`;
    }
    const p50 = fmtUnit(result.ms.p50, b.unit);
    const p90 = fmtUnit(result.ms.p90, b.unit);
    const p99 = fmtUnit(result.ms.p99, b.unit);
    return (
      `As of ${date}, ${subject} is ${p50} at the median (p50, 24h window), with ${p90} at p90 and ${p99} at p99.` +
      (rank > 0
        ? ` ${result.name} ranks #${rank} of ${sorted.length} chains measured on this benchmark.`
        : "")
    );
  }
  const { leader, providers, chainLabel, regionLeaders } = data;
  if (!leader) {
    return `${chainLabel} ${metricPhrase(b.metric)} is measured continuously on this benchmark. Live numbers will appear here as soon as the harness reports fresh samples.`;
  }
  const base = `As of ${date}, ${leader.name} leads ${chainLabel} ${metricPhrase(b.metric)} at ${fmtUnit(leader.ms.p50, b.unit)} (p50, 24h window), measured across ${providers.length} providers.`;
  const regional = regionLeaderSentence(regionLeaders);
  return regional ? `${base} ${regional}` : base;
}

function pageTitle(data: ChainPageData): string {
  const b = data.benchmark;
  if (data.shape === "row") {
    return data.result.ms.p50 > 0
      ? `${data.explainer.h2}: ${fmtUnit(data.result.ms.p50, b.unit)} p50 live`
      : `${data.explainer.h2}: live benchmark`;
  }
  return data.leader
    ? `${data.explainer.h2}: ${data.leader.name} leads at ${fmtUnit(data.leader.ms.p50, b.unit)}`
    : `${data.explainer.h2}: live benchmark`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug, chain } = await params;
  const data = await loadChainPage(slug, chain);
  if (!data) return {};
  const title = pageTitle(data);
  const description = capDescription(
    stripInlineMarkdown(data.explainer.body),
    158,
  );
  const ogImage = `${SITE.url}/api/og/${data.benchmark.slug}`;
  return pageMetadata({
    path: `/benchmarks/${data.benchmark.slug}/${chain}`,
    title,
    description,
    type: "article",
    ogImage,
  });
}

export default async function BenchmarkChainPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug, chain } = await params;
  const data = await loadChainPage(slug, chain);
  if (!data) notFound();
  const { benchmark, explainer } = data;

  const benchmarkUrl = `${SITE.url}/benchmarks/${benchmark.slug}`;
  const pageUrl = `${benchmarkUrl}/${chain}`;
  const catColor = CATEGORY_COLOR[benchmark.category];
  const crumbName =
    data.shape === "row" ? data.result.name : data.chainLabel;
  const keyFacts = buildKeyFacts(data);
  const gatedChains = new Set(explainerChains(benchmark));

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        "@id": `${pageUrl}#article`,
        headline: explainer.h2,
        description: capDescription(stripInlineMarkdown(explainer.body), 158),
        url: pageUrl,
        mainEntityOfPage: pageUrl,
        articleBody: `${keyFacts} ${stripInlineMarkdown(explainer.body)}`,
        image: `${SITE.url}/api/og/${benchmark.slug}`,
        dateModified: benchmark.lastRunAt,
        author: { "@id": `${SITE.url}/#org` },
        publisher: { "@id": `${SITE.url}/#org` },
        about: { "@id": `${benchmarkUrl}#dataset` },
        isPartOf: { "@id": `${benchmarkUrl}#article` },
      },
      buildBreadcrumbJsonLd([
        { name: "Home", item: SITE.url },
        { name: "Benchmarks", item: `${SITE.url}/benchmarks` },
        { name: benchmark.title, item: benchmarkUrl },
        { name: crumbName, item: pageUrl },
      ]),
    ],
  };

  return (
    <article className="mx-auto max-w-5xl w-full px-4 sm:px-6 pt-10 sm:pt-14 overflow-x-clip min-w-0">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />

      <Breadcrumb
        compactLast
        items={[
          { label: "Home", href: "/" },
          { label: "Benchmarks", href: "/benchmarks" },
          { label: benchmark.title, href: `/benchmarks/${benchmark.slug}` },
          { label: crumbName },
        ]}
      />

      <Link
        href={`/benchmarks/${benchmark.slug}`}
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        Full benchmark: {benchmark.title}
      </Link>

      <div className="mt-6 flex flex-wrap items-center gap-3 font-sans text-[11px] uppercase tracking-[0.1em] sm:tracking-[0.18em] text-ink-muted font-medium">
        <span style={{ color: catColor ?? "var(--color-ink-soft)" }}>
          {benchmark.category}
        </span>
        <span className="text-ink-faint">{crumbName}</span>
      </div>

      <h1 className="mt-5 display text-3xl sm:text-4xl md:text-5xl tracking-tight text-ink break-words">
        {explainer.h2}
      </h1>

      {/* Dated key-facts line. Server-rendered first so the citable,
          date-stamped stat lands in the first ~100 words of the document. */}
      <p className="mt-4 max-w-3xl text-lg sm:text-xl text-ink-muted leading-snug break-words">
        {keyFacts}
      </p>

      <div className="mt-6 max-w-3xl space-y-3 text-[15px] leading-relaxed text-ink-soft break-words">
        {explainer.body.split(/\n\n+/).map((para, i) => (
          <p key={i}>{para.trim()}</p>
        ))}
      </div>

      {data.shape === "row" ? (
        <RowComparison data={data} chain={chain} gatedChains={gatedChains} />
      ) : (
        <DimensionLeaderboard data={data} />
      )}

      {/* Sibling chain pages, for the dimension shape (the row shape's
          comparison list already links siblings). */}
      {data.shape === "dimension" && (
        <SiblingChains
          benchmark={benchmark}
          current={chain}
          gatedChains={gatedChains}
        />
      )}

      <p className="mt-10 text-sm text-ink-muted">
        Methodology, charts and the full ledger live on the{" "}
        <Link href={`/benchmarks/${benchmark.slug}`} className="lnk">
          {benchmark.title}
        </Link>{" "}
        page. Raw data:{" "}
        <a className="lnk" href={`/api/stat/${benchmark.slug}`}>
          JSON endpoint
          <ArrowUpRight size={12} strokeWidth={2} className="inline ml-1" />
        </a>
        .
      </p>
    </article>
  );
}

/** Row shape: cross-chain ranking with the current chain highlighted.
 *  Every sibling with its own explainer links to its dedicated page
 *  (internal mesh); chains without one deep-link to their anchor on the
 *  parent bench. */
function RowComparison({
  data,
  chain,
  gatedChains,
}: {
  data: RowShape;
  chain: string;
  gatedChains: Set<string>;
}) {
  const { benchmark, result, sorted } = data;
  if (sorted.length < 2) return null;
  return (
    <section className="mt-12 max-w-3xl">
      <h2 className="display text-2xl tracking-tight text-ink">
        How {result.name} compares
      </h2>
      <p className="mt-3 text-sm text-ink-muted">
        Live p50 over the last 24 hours across every chain on this benchmark,
        ranked {benchmark.higherIsBetter ? "highest" : "lowest"} first.
      </p>
      <ol className="mt-6 space-y-1">
        {sorted.map((r, i) => {
          const isCurrent = r.slug === chain;
          const href = gatedChains.has(r.slug)
            ? `/benchmarks/${benchmark.slug}/${r.slug}`
            : `/benchmarks/${benchmark.slug}#${r.slug}`;
          const row = (
            <span className="flex items-baseline justify-between gap-4">
              <span className="flex items-baseline gap-3 min-w-0">
                <span className="font-mono text-xs text-ink-faint w-6 shrink-0">
                  #{i + 1}
                </span>
                <span
                  className={
                    isCurrent ? "font-semibold text-ink" : "text-ink-soft"
                  }
                >
                  {r.name}
                </span>
              </span>
              <span className="font-mono text-sm text-ink">
                {fmtUnit(r.ms.p50, benchmark.unit)}
              </span>
            </span>
          );
          return (
            <li
              key={r.slug}
              className={`rounded-md px-3 py-2 ${isCurrent ? "card-soft" : ""}`}
            >
              {isCurrent ? (
                row
              ) : (
                <Link href={href} className="block hover:text-ink">
                  {row}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Dimension shape: provider leaderboard scoped to this chain, plus the
 *  per-region leader breakdown when the bench declares regions. */
function DimensionLeaderboard({ data }: { data: DimensionShape }) {
  const { benchmark, chainLabel, providers, regionLeaders } = data;
  if (providers.length === 0) return null;
  return (
    <>
      <section className="mt-12 max-w-3xl">
        <h2 className="display text-2xl tracking-tight text-ink">
          {chainLabel} leaderboard
        </h2>
        <p className="mt-3 text-sm text-ink-muted">
          Live p50 over the last 24 hours, scoped to {chainLabel} only, ranked{" "}
          {benchmark.higherIsBetter ? "highest" : "lowest"} first. Cross-region
          average; the regional breakdown below shows where leaders diverge.
        </p>
        <ol className="mt-6 space-y-1">
          {providers.map((r, i) => (
            <li key={r.slug} className="rounded-md px-3 py-2">
              <Link href={`/products/${r.slug}`} className="block hover:text-ink">
                <span className="flex items-baseline justify-between gap-4">
                  <span className="flex items-baseline gap-3 min-w-0">
                    <span className="font-mono text-xs text-ink-faint w-6 shrink-0">
                      #{i + 1}
                    </span>
                    <span className={i === 0 ? "font-semibold text-ink" : "text-ink-soft"}>
                      {r.name}
                    </span>
                  </span>
                  <span className="font-mono text-sm text-ink">
                    {fmtUnit(r.ms.p50, benchmark.unit)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      {regionLeaders.length > 1 && (
        <section className="mt-10 max-w-3xl">
          <h2 className="display text-xl tracking-tight text-ink">
            Leader by region on {chainLabel}
          </h2>
          <ul className="mt-4 space-y-1">
            {regionLeaders.map((r) => (
              <li
                key={r.region}
                className="flex items-baseline justify-between gap-4 rounded-md px-3 py-2"
              >
                <span className="text-ink-soft">{r.region}</span>
                <span className="font-mono text-sm text-ink">
                  {r.leader.name} · {fmtUnit(r.leader.ms.p50, benchmark.unit)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function SiblingChains({
  benchmark,
  current,
  gatedChains,
}: {
  benchmark: Benchmark;
  current: string;
  gatedChains: Set<string>;
}) {
  const siblings = (benchmark.dimensions?.chain ?? []).filter(
    (c) =>
      c.value !== current &&
      c.value.toLowerCase() !== "all" &&
      gatedChains.has(c.value),
  );
  if (siblings.length === 0) return null;
  return (
    <nav className="mt-10 max-w-3xl" aria-label="Other chains">
      <h2 className="label-mono text-ink-muted">Other chains</h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {siblings.map((c) => (
          <li key={c.value}>
            <Link
              href={`/benchmarks/${benchmark.slug}/${c.value}`}
              className="inline-block rounded-md card-soft px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
            >
              {c.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
