import Link from "next/link";
import { isExpiredRpcPage } from "@/lib/provider-filters";
import { isDevOnlyRoute } from "@/lib/removed-benches";
import { fetchRpcHub, NON_CHAIN_RPC_SLUGS } from "@/lib/rpc-hub-stats";
import { loadSitemapBlob } from "@/lib/sitemap-blob";
import { getSpecs } from "@/lib/spec";
import { RpcHubTabs } from "@/components/rpc-hub-tabs";
import { pageMetadata } from "@/lib/page-metadata";
import { capDescription, capSnippet } from "@/lib/seo-text";
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
  "RPC providers ranked per chain from 3 regions: free public endpoints with URLs, plus Alchemy, Chainstack and QuickNode on private (API-key) endpoints, ranked apart.";

export const metadata: import("next").Metadata = pageMetadata({
  path: "/rpc",
  title: "RPC providers by chain: public and private endpoints, by latency",
  description: capSnippet(DESCRIPTION),
});

export const revalidate = 3600;

/** "Arbitrum" from either title shape the cluster uses. */
function chainLabelOf(s: { title: string; slug: string }): string {
  const m = s.title.match(/free ([A-Za-z0-9 .-]+?) RPC/i) ?? s.title.match(/^([A-Za-z0-9 .-]+?) RPC/i);
  return m ? m[1] : s.slug.replace(/-rpc$/, "");
}

export default async function RpcHubPage() {
  const [snapshot, specs, sitemapBlob] = await Promise.all([fetchRpcHub(), getSpecs(), loadSitemapBlob()]);
  // Spec-derived chain list: stable across snapshot outages, so the
  // JSON-LD ItemList and the empty state never churn with data blips.
  // Restricted to the benches the worker publishes in the sitemap: a chain
  // bench under the thin gate is noindex on its own page and must not be
  // linked from here (36 such links on 2026-09-19). Without the blob, no
  // restriction rather than an empty hub.
  const indexable = sitemapBlob
    ? new Set(sitemapBlob.benches.filter((b) => !isExpiredRpcPage(b)).map((b) => b.slug))
    : null;
  const rpcSpecs = specs
    .filter((s) => s.slug.endsWith("-rpc") && !NON_CHAIN_RPC_SLUGS.has(s.slug))
    .filter((s) => !indexable || indexable.has(s.slug))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  // The four pills: the chain pages with the most search demand (Search
  // Console 2026-09-19), not the first four of the alphabet.
  const FEATURED = ["arbitrum-rpc", "ethereum-rpc", "linea-rpc", "ronin-rpc"];
  const featured = FEATURED.map((slug) => rpcSpecs.find((s) => s.slug === slug)).filter(
    (s): s is (typeof rpcSpecs)[number] => Boolean(s),
  );
  const linkableSlugs = rpcSpecs.map((s) => s.slug);
  // Chains whose page carries the API-key cohort (tier dimension): named
  // in the intro so the "<chain> rpc provider" searcher sees Alchemy,
  // Chainstack and QuickNode are measured too, behind the selector.
  const keyedChains = rpcSpecs
    .filter((s) => (s.dimensions?.tier ?? []).some((t) => t.value === "keyed"))
    .map(chainLabelOf);

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
          name: "Per-chain RPC benchmarks by OpenChainBench",
          description:
            "Live per-chain benchmarks of RPC endpoints: free, no-key public gateways measured every 60 seconds from 3 regions, and on the major chains a private (API-key) cohort (Alchemy, Chainstack, QuickNode) measured every 120 seconds and ranked separately.",
          numberOfItems: rpcSpecs.length,
          itemListElement: rpcSpecs.map((s, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: s.title,
            url: `${SITE.url}/benchmarks/${s.slug}`,
          })),
        }
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
          RPC providers by chain: public and private endpoints, ranked by latency
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Every free, no-key public RPC endpoint, measured per chain with
          the same probe: one identical{" "}
          <code>eth_getBlockByNumber(&quot;latest&quot;, false)</code> call with a
          rotating request id (defeats CDN body-keyed caches) every 60
          seconds from 3 regions (N. Virginia, Amsterdam, Singapore).
          {keyedChains.length > 0 ? (
            <>
              {" "}
              On {keyedChains.length} chains ({keyedChains.join(", ")}) the same
              page also ranks the private (API-key) endpoints of Alchemy,
              Chainstack and QuickNode, probed every 120 seconds with plan tiers disclosed;
              the Access selector below switches between the two cohorts,
              which are never ranked against each other.
            </>
          ) : null}{" "}
          The matrix folds the per-chain leaderboards
          into one view: the lowest median per chain, per region,
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
          {featured.map((s) => (
            <Link
              key={s.slug}
              href={`/benchmarks/${s.slug}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 hover:bg-sky-500/15"
            >
              <span className="text-ink">{chainLabelOf(s)} RPC endpoints</span>
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

      {!isDevOnlyRoute("/speedtest-rpc") && (
      <section className="mb-8 rounded-lg border border-ink/10 card-soft px-4 py-3 flex items-start gap-3">
        <span className="mt-0.5 inline-block w-2 h-2 rounded-full shrink-0" style={{ background: "var(--color-good)" }} aria-hidden />
        <p className="text-sm text-ink leading-snug">
          Want these numbers from <em>your</em> connection?{" "}
          <Link href="/speedtest-rpc" className="font-semibold underline underline-offset-2">
            Run the browser RPC speed test →
          </Link>{" "}
          <span className="text-ink-faint">
            Paste any endpoints (keyed included), no install, URLs never leave your browser.
          </span>
        </p>
      </section>
      )}

      {snapshot ? (
        <>
          {/* Summary cards, the Endpoints (public / API key) selector and
              the chain × provider tabs live in the client component so
              one click swaps the whole block between the two cohorts. */}
          <h2 className="label-mono text-ink-muted mb-3">
            Lowest 24h median per chain and region, public and private cohorts
          </h2>
          <RpcHubTabs snapshot={snapshot} linkableSlugs={linkableSlugs} />

          {/* Every indexable chain page as a plain link: the leaderboard
              above renders 40 rows before "Show all", this nav is what a
              crawler follows to the rest. */}
          <nav className="mt-8" aria-labelledby="rpc-all-chains">
            <h2 id="rpc-all-chains" className="label-mono text-ink-muted">
              All {rpcSpecs.length} chain RPC pages
            </h2>
            <ul className="mt-3 flex flex-wrap gap-2 text-[12px]">
              {rpcSpecs.map((s) => (
                <li key={s.slug}>
                  <Link href={`/benchmarks/${s.slug}`} className="pill-lnk">
                    {chainLabelOf(s)}
                    <span className="sr-only"> RPC endpoints</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

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
            The cross-chain snapshot has not been published yet. The
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
                  {chainLabelOf(s)} RPC endpoints
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-16 pt-6 border-t border-ink/10 text-[12px] text-ink-soft leading-relaxed">
        <h2 className="label-mono text-ink-faint mb-2">Methodology</h2>
        <p>
          Each chain row aggregates that chain&apos;s dedicated bench: an
          identical JSON-RPC POST (<code>eth_getBlockByNumber(&quot;latest&quot;, false)</code> with
          rotating request id, or the chain&apos;s equivalent head call) sent every 60 seconds to
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
          Private cohort (API key): on the chains that carry one, Alchemy, Chainstack
          and QuickNode are probed on their keyed endpoints every 120
          seconds from the same three regions with the same payload and
          classification; keys never leave the probe environment and the
          plan tier of every key is disclosed on the chain page. The two
          cohorts share a page per chain and a selector, not a table:
          shared gateways at 60 s and metered endpoints at 120 s are not
          the same measurement.
        </p>
        <p className="mt-3">
          MEV-protection gateways (Flashbots Protect, MEV Blocker, Blink,
          bloXroute Protect) share this probe surface but are optimised
          for send-tx privacy, not read speed. They are ranked against
          each other on{" "}
          <Link
            href="/benchmarks/mev-protect-rpc"
            className="underline hover:text-ink"
          >
            mev-protect-rpc
          </Link>{" "}
          and deliberately kept off this chain matrix so that a fast
          public read gateway is never compared against a private-mempool
          RPC on the wrong axis.
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
