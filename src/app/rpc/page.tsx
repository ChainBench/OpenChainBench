import Link from "next/link";
import { fetchRpcHub } from "@/lib/rpc-hub-stats";
import { getSpecs } from "@/lib/spec";
import { RpcHubTabs } from "@/components/rpc-hub-tabs";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

/**
 * Hub landing page for the per-chain RPC bench cluster (044-053). One
 * server fetch of the worker-written `rpc-hub` cohort snapshot, one
 * client tab swap between the chain matrix and the provider pivot.
 *
 * Blob-only: the snapshot is assembled by the materialize worker from
 * the `-rpc` bench blobs; this page never touches Prometheus. When the
 * snapshot is missing (worker not yet writing it), the page renders a
 * "warming up" shell with links to the per-chain bench pages — no 404,
 * no throw. The chain list is derived from the spec directory, so a
 * new `<chain>-rpc` YAML lights up here automatically.
 */

const DESCRIPTION =
  "Free public RPC endpoints benchmarked per chain from 3 regions. Live 24h p50 latency, per-region leaders and cross-chain provider coverage.";

export const metadata: import("next").Metadata = pageMetadata({
  path: "/rpc",
  title: "RPC Node Benchmarks by Chain & Region",
  description: DESCRIPTION,
});

export const revalidate = 60;

export default async function RpcHubPage() {
  const [snapshot, specs] = await Promise.all([fetchRpcHub(), getSpecs()]);
  // Spec-derived chain list: stable across snapshot outages, so the
  // JSON-LD ItemList and the empty state never churn with data blips.
  const rpcSpecs = specs
    .filter((s) => s.slug.endsWith("-rpc"))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const breadcrumbLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "RPC benchmarks", item: `${SITE.url}/rpc` },
    ]),
  };

  const itemListLd =
    rpcSpecs.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: "Per-chain free RPC benchmarks by OpenChainBench",
          description:
            "Live per-chain benchmarks of free, no-key public RPC endpoints: latency, reliability and archive depth measured every 15 seconds from 3 regions.",
          numberOfItems: rpcSpecs.length,
          itemListElement: rpcSpecs.map((s, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: s.title,
            url: `${SITE.url}/benchmarks/${s.slug}`,
          })),
        }
      : null;

  // Fastest provider overall: best chain leader across the whole matrix.
  const fastest = snapshot
    ? snapshot.chains.reduce<
        { chain: string; provider: string; p50Ms: number } | null
      >((acc, c) => {
        if (!c.best) return acc;
        if (!acc || c.best.p50Ms < acc.p50Ms) {
          return {
            chain: c.name,
            provider: c.best.providerName,
            p50Ms: c.best.p50Ms,
          };
        }
        return acc;
      }, null)
    : null;

  return (
    <article
      className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16"
      style={{
        background:
          "linear-gradient(180deg, rgba(14,165,233,0.05), rgba(14,165,233,0) 320px)",
      }}
    >
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />
      {itemListLd && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListLd) }}
        />
      )}

      <header className="mb-8">
        <p className="label-mono text-sky-600 mb-2">RPC nodes</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">
          RPC Node Benchmarks
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Every free, no-key public RPC endpoint, measured per chain with
          the same probe: one identical <code>eth_blockNumber</code> call
          every 15 seconds from 3 regions (N. Virginia, Amsterdam,
          Singapore). The matrix below folds the per-chain leaderboards
          into one view — fastest provider per chain, fastest per region,
          and which gateway covers your whole multichain stack. Headline
          numbers are 24h p50 round-trip latency; methodology and
          exclusion rules live on the{" "}
          <Link
            href="/benchmarks/rpc-capabilities"
            className="underline hover:text-ink"
          >
            parent rpc-capabilities benchmark
          </Link>
          .
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          {rpcSpecs.slice(0, 4).map((s) => (
            <Link
              key={s.slug}
              href={`/benchmarks/${s.slug}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 hover:bg-sky-500/15"
            >
              <span
                className="label-mono text-ink-faint text-[10px]"
                style={{ fontFamily: "var(--font-mono, monospace)" }}
              >
                Bench
              </span>
              <span className="text-ink">{s.slug}</span>
            </Link>
          ))}
          <Link
            href="/benchmarks/rpc-capabilities"
            className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 px-3 py-1 text-ink-soft hover:text-ink"
          >
            Methodology: rpc-capabilities
          </Link>
        </div>
      </header>

      {snapshot ? (
        <>
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <SummaryCard
              label="Chains benched"
              value={String(snapshot.totals.chains)}
              accent="#0ea5e9"
            />
            <SummaryCard
              label="Unique providers"
              value={String(snapshot.totals.uniqueProviders)}
            />
            <SummaryCard
              label="Probe regions"
              value={String(snapshot.totals.regions)}
              tip="us-east (N. Virginia), eu-west (Amsterdam), Singapore. Every provider is probed from all three."
            />
            <SummaryCard
              label="Fastest provider overall"
              value={
                fastest
                  ? `${fastest.provider} · ${fmtMs(fastest.p50Ms)}`
                  : "..."
              }
              tip={
                fastest
                  ? `Best chain leader across the matrix: ${fastest.provider} on ${fastest.chain} (24h p50, all regions).`
                  : undefined
              }
            />
          </section>

          <RpcHubTabs snapshot={snapshot} />

          <p className="mt-4 text-[11px] text-ink-faint italic">
            Source: the open-source{" "}
            <Link
              href="https://github.com/ChainBench/OpenChainBench/tree/main/harnesses/rpc-capabilities"
              className="underline hover:text-ink"
              rel="noopener noreferrer"
              target="_blank"
            >
              rpc-capabilities harness
            </Link>
            , one probe fleet per chain. Click a chain row for the full
            per-chain leaderboard with region tabs, success-rate
            classification and archive-depth audits; click a provider
            for its product page. Refresh interval 60s.
          </p>
        </>
      ) : (
        <section className="rounded-xl border border-ink/10 card-soft p-6 sm:p-8">
          <p className="label-mono text-[10px] text-ink-faint mb-2">
            Data warming up
          </p>
          <p className="text-sm text-ink-soft max-w-2xl leading-relaxed">
            The cross-chain snapshot has not been published yet — the
            materialize worker writes it every minute once the RPC
            cluster is sweeping. The per-chain leaderboards are already
            live on their bench pages:
          </p>
          <ul className="mt-4 flex flex-wrap gap-2 text-[12.5px]">
            {rpcSpecs.map((s) => (
              <li key={s.slug}>
                <Link
                  href={`/benchmarks/${s.slug}`}
                  className="inline-flex rounded-full border border-ink/15 px-3 py-1 text-ink-soft hover:text-ink hover:border-ink/30"
                >
                  {s.slug}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-16 pt-6 border-t border-ink/10 text-[12px] text-ink-soft leading-relaxed">
        <p className="label-mono text-ink-faint mb-2">Methodology</p>
        <p>
          Each chain row aggregates that chain&apos;s dedicated bench: an
          identical JSON-RPC POST (<code>eth_blockNumber</code> or the
          chain&apos;s equivalent head call) sent every 15 seconds to
          every free, no-key public endpoint from us-east, eu-west and
          Singapore. Headline figures are the 50th percentile of
          client-side round-trip latency over the trailing 24 hours,
          averaged across the three probe origins; per-region columns
          re-scope the same percentile to a single origin. Responses are
          classified (ok / http_err / jsonrpc_err / stale / timeout) so
          a fast error message never ranks as fastest. Providers that
          key-gate, region-block or rate-limit below the probe cadence
          are excluded rather than listed with an asterisk.
        </p>
        <p className="mt-3">
          Data and methodology released under{" "}
          <Link
            href="https://creativecommons.org/licenses/by/4.0/"
            className="underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            CC BY 4.0
          </Link>
          . Reuse with attribution to OpenChainBench.
        </p>
      </footer>
    </article>
  );
}

function SummaryCard({
  label,
  value,
  accent,
  tip,
}: {
  label: string;
  value: string;
  accent?: string;
  tip?: string;
}) {
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15"
      title={tip}
    >
      <p
        className="label-mono text-[10px] text-ink-faint mb-1 flex items-center gap-1.5"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {accent && (
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: accent }}
          />
        )}
        {label}
      </p>
      <p className="text-lg sm:text-2xl font-semibold tabular-nums leading-tight">
        {value}
      </p>
    </div>
  );
}

function fmtMs(v: number): string {
  if (!Number.isFinite(v)) return "...";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}
