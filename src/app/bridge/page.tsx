import Link from "next/link";
import { fetchBridgeHub } from "@/lib/bridge-hub-stats";
import { BridgeHubTable } from "@/components/bridge-hub-table";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

const DESCRIPTION =
  "Live cross-chain bridge benchmarks: cheapest all-in fee and fastest quote API for $300 USDC across Across, deBridge, LI.FI, Mobula, Near Intents and Relay. 4 corridors, refreshed every 5 minutes.";

export const metadata: import("next").Metadata = pageMetadata({
  path: "/bridge",
  title: "Cheapest cross-chain bridge 2026, live ranking",
  description: DESCRIPTION,
});

export const revalidate = 60;

export default async function BridgeHubPage() {
  const hub = await fetchBridgeHub();

  const breadcrumbLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Bridge benchmarks", item: `${SITE.url}/bridge` },
    ]),
  };

  const itemListLd = hub
    ? {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: "Cross-chain bridge benchmarks by OpenChainBench",
        description: DESCRIPTION,
        numberOfItems: hub.bridgeCount,
        itemListElement: hub.providers.map((p, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: p.name,
          url: `${SITE.url}/products/${p.slug}`,
        })),
      }
    : null;

  return (
    <article
      className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16"
      style={{
        background:
          "linear-gradient(180deg, rgba(99,102,241,0.05), rgba(99,102,241,0) 320px)",
      }}
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />
      {itemListLd && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListLd) }}
        />
      )}

      <header className="mb-8">
        <p className="label-mono text-indigo-600 mb-2">Bridges</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">
          Cross-chain bridge benchmarks, live.
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Two live benches, sampled every five minutes from three regions
          (EU-West, US-East, Singapore). One measures the all-in cost of
          bridging $300 USDC across four Solana/Base/Arbitrum/HyperCore
          corridors. The other measures how fast each bridge returns a
          usable quote from each origin. Same corridors, same notional.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          <Link
            href="/benchmarks/bridge-fee"
            className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 hover:bg-indigo-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench 003
            </span>
            <span className="text-ink">bridge-fee</span>
          </Link>
          <Link
            href="/benchmarks/bridge-quote-latency"
            className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 hover:bg-indigo-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench 002
            </span>
            <span className="text-ink">bridge-quote-latency</span>
          </Link>
          <span className="inline-flex items-center rounded-full border border-ink/10 px-3 py-1 text-ink-muted">
            eu-west only
          </span>
        </div>
      </header>

      {hub ? (
        <>
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            <SummaryCard
              label="Cheapest bridge"
              value={
                hub.cheapestName && hub.cheapestP50 != null
                  ? `${hub.cheapestName} · ${fmtPct(hub.cheapestP50)}`
                  : "..."
              }
              accent="#6366f1"
              tip="Lowest p50 all-in cost (fees + slippage + destination gas) for $300 USDC, trailing 24h, cross-corridor average."
            />
            <SummaryCard
              label="Fastest quote API"
              value={
                hub.fastestName && hub.fastestP50 != null
                  ? `${hub.fastestName} · ${fmtMs(hub.fastestP50)}`
                  : "..."
              }
              tip="Lowest p50 time-to-first-quote, trailing 24h, cross-corridor average."
            />
            <SummaryCard
              label="Bridges tracked"
              value={String(hub.bridgeCount)}
              tip="Across, deBridge, LI.FI, Mobula, Near Intents, Relay."
            />
            <SummaryCard
              label="Probe region"
              value="1 · eu-west"
              tip="All measurements originate from eu-west (Amsterdam). Results reflect European latency and solver inventory. Multi-region coverage (us-east, Singapore) requires additional harness instances."
            />
          </section>

          <section className="mb-10">
            <div className="flex items-baseline justify-between gap-4 mb-1">
              <h2 className="display text-xl sm:text-2xl text-ink">
                Bridge leaderboard
              </h2>
              <div className="flex gap-3 text-[12px]">
                <Link
                  href="/benchmarks/bridge-fee"
                  className="text-ink-soft hover:text-ink underline"
                >
                  fee breakdown
                </Link>
                <Link
                  href="/benchmarks/bridge-quote-latency"
                  className="text-ink-soft hover:text-ink underline"
                >
                  quote speed breakdown
                </Link>
              </div>
            </div>
            <p className="text-sm text-ink-muted mb-4">
              Sorted by fee p50 (all-in cost at $300 USDC). Quote columns from
              bench 002. Success from fee bench. Trailing 24h, eu-west, cross-corridor average.
            </p>
            <BridgeHubTable rows={hub.providers} />
            <p className="mt-2 text-[11px] text-ink-faint italic">
              Across is not in the quote latency bench (dashes in quote columns).
              Per-corridor splits on the individual bench pages.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="display text-xl sm:text-2xl text-ink mb-4">
              Three pricing architectures
            </h2>
            <div className="grid sm:grid-cols-3 gap-4">
              <ArchCard
                label="Intent layers"
                examples={["Mobula", "Relay", "Across", "Near Intents"]}
                body="Compress fees, slippage and destination gas into a single solver-quoted spread. Competitive on liquid corridors where multiple solvers compete on the same route."
              />
              <ArchCard
                label="Aggregators"
                examples={["LI.FI"]}
                body="Route through the cheapest available underlying bridge plus a thin markup. Benefit is route coverage: they surface paths that no single protocol quotes."
              />
              <ArchCard
                label="Direct protocols"
                examples={["deBridge"]}
                body="Charge a native-token fee front-loaded into the quote. Fixed fee dominates at $300 notional; the leaderboard re-orders at $10k where that component dilutes."
              />
            </div>
          </section>

          <section className="mb-8">
            <h2 className="display text-xl sm:text-2xl text-ink mb-3">
              Corridors measured
            </h2>
            <div className="flex flex-wrap gap-2 mb-3">
              {hub.corridors.map((c) => (
                <span
                  key={c.value}
                  className="inline-flex items-center rounded-full border border-ink/10 px-3 py-1 text-[12px] text-ink-soft"
                >
                  {c.label}
                </span>
              ))}
            </div>
            <p className="text-sm text-ink-muted">
              Per-corridor leaders can diverge from the cross-corridor
              aggregate. Full corridor tabs with p50/p90/p99 splits are on
              the{" "}
              <Link
                href="/benchmarks/bridge-fee"
                className="underline hover:text-ink"
              >
                bridge-fee
              </Link>{" "}
              and{" "}
              <Link
                href="/benchmarks/bridge-quote-latency"
                className="underline hover:text-ink"
              >
                bridge-quote-latency
              </Link>{" "}
              bench pages.
            </p>
          </section>
        </>
      ) : (
        <section className="rounded-xl border border-ink/10 card-soft p-6 sm:p-8">
          <p className="label-mono text-[10px] text-ink-faint mb-2">
            Data warming up
          </p>
          <p className="text-sm text-ink-soft max-w-2xl leading-relaxed">
            The bridge snapshot has not been published yet. Individual bench
            pages are already live:
          </p>
          <ul className="mt-4 flex flex-wrap gap-2 text-[12.5px]">
            <li>
              <Link
                href="/benchmarks/bridge-fee"
                className="inline-flex rounded-full border border-ink/15 px-3 py-1 text-ink-soft hover:text-ink hover:border-ink/30"
              >
                bridge-fee
              </Link>
            </li>
            <li>
              <Link
                href="/benchmarks/bridge-quote-latency"
                className="inline-flex rounded-full border border-ink/15 px-3 py-1 text-ink-soft hover:text-ink hover:border-ink/30"
              >
                bridge-quote-latency
              </Link>
            </li>
          </ul>
        </section>
      )}

      <footer className="mt-16 pt-6 border-t border-ink/10 text-[12px] text-ink-soft leading-relaxed">
        <p className="label-mono text-ink-faint mb-2">Methodology</p>
        <p>
          Fee column: <code>bridge_cost_percent</code> (all-in: fees +
          slippage + destination gas) at $300 USDC, p50 over the trailing
          24h averaged across corridors each provider supports. Quote
          latency: wall-clock time from request send to last byte received,
          p50 via{" "}
          <code>
            histogram_quantile(0.50, sum by (le)
            (rate(bridge_quote_latency_ms_bucket[24h])))
          </code>
          . Both benches run from eu-west only; multi-region expansion
          requires additional harness instances. Failures (quote_failed,
          unsupported route, timeout) excluded from aggregates, counted
          toward success rate.
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

function ArchCard({
  label,
  examples,
  body,
}: {
  label: string;
  examples: string[];
  body: string;
}) {
  return (
    <div className="card-soft rounded-xl border border-ink/10 p-4 sm:p-5">
      <p className="font-semibold text-ink mb-1">{label}</p>
      <p className="text-[11px] text-ink-faint mb-3">{examples.join(", ")}</p>
      <p className="text-sm text-ink-soft leading-relaxed">{body}</p>
    </div>
  );
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return "...";
  return `${v.toFixed(2)}%`;
}

function fmtMs(v: number): string {
  if (!Number.isFinite(v)) return "...";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}
