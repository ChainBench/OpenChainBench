import type { Metadata } from "next";
import Link from "next/link";
import { SectionRule } from "@/components/section-rule";
import { aboutPageLd } from "@/lib/hub-jsonld";
import { safeJsonLd } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  path: "/about",
  title: "About",
  description: "Why OpenChainBench exists and how it stays honest.",
});

export default function AboutPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
      {aboutPageLd().map((ld, i) => (
        <script
          key={i}
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(ld) }}
        />
      ))}
      <header className="border-b-2 border-ink pb-6">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">
          About OpenChainBench
        </h1>
        <p className="mt-3 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
          Open, reproducible benchmarks for crypto infrastructure. Measured in
          the open, published in the same format every time.
        </p>
      </header>

      <SectionRule label="Why" number="i" />
      <p className="text-base sm:text-lg leading-relaxed text-ink-soft">
        Crypto infrastructure runs the world&apos;s open financial rails, and almost none of it is benchmarked in public. Every aggregator, bridge, RPC and market-data feed quotes its own numbers, on its own terms, with its own regions and its own definitions of &ldquo;fast&rdquo;. OpenChainBench picks one definition at a time, runs the experiment in the open, and publishes the script alongside the result.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        The goal is to make performance an observable property of crypto infrastructure. like uptime in SaaS, or p99 in databases. so builders can choose providers on data and users can hold them to it.
      </p>

      <SectionRule label="What we measure today" number="ii" />
      <ul className="space-y-3 text-base leading-relaxed text-ink-soft">
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Aggregators &amp; data APIs</strong>. head-lag (on-chain event → feed), metadata coverage, network coverage, wallet-label coverage. Mobula, Codex, GeckoTerminal, Jupiter, Moralis, Helius and 6 wallet-label providers compared live.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Bridges</strong>. quote latency and effective fee on $300 USDC corridors. Mobula, Relay, LiFi, Debridge.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Blockchains</strong>. L1 finality time across 11 chains. L2 sequencer block time across 9 L2s.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Trading venues</strong>. all-in opening cost on perp DEXes (Hyperliquid, Lighter, dYdX, GMX, gains). Stablecoin peg deviation on USDC, USDT, DAI + USDT-anchored swap-cost on FDUSD, USDe.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>RPCs</strong>. fastest free no-key public RPC across <strong>10 EVM chains × 15 providers</strong> (PublicNode, dRPC, 1RPC, Tenderly, Nodies, Lava, Merkle, MeowRPC, Flashbots, Cloudflare, foundation endpoints). Plus gas-oracle prediction error (Blocknative, Owlracle, Etherscan, PublicNode feeHistory) on Ethereum, Polygon, Avalanche.</span></li>
      </ul>
      <p className="mt-4 text-base text-ink-muted">
        13 live benchmarks. ~150 (provider × chain) probe pairs. Every metric is queryable on the public Prometheus and reproducible from the harness source.
      </p>

      <SectionRule label="Independence and disclosure" number="iii" />
      <p className="text-base leading-relaxed text-ink-soft">
        OpenChainBench is funded by <a className="lnk" href="https://mobula.io" rel="noopener">Mobula</a> because we needed honest infrastructure benchmark data internally and saw no neutral source existed. The site is open-sourced because the industry needs it.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        <strong>Mobula competes in five live benchmarks</strong>: aggregator head lag, bridge fee, bridge quote latency, network coverage and metadata coverage. Mobula currently leads aggregator head lag and bridge quote latency. This is a real conflict of interest and we want it visible above the fold, not buried.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        Three safeguards stand against the conflict:
      </p>
      <ul className="mt-3 space-y-3 text-base leading-relaxed text-ink-soft">
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Open Prometheus data</strong>. Every number on the site is a literal <code>quantile_over_time</code> query. Anyone can hit our <Link className="lnk" href="/api/citable">/api/citable</Link> or <code>/api/stat/&lt;slug&gt;</code> endpoint and re-derive the leaderboard with their own aggregation. If Mobula were inflating its rank, the raw data would show it.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Open harness source</strong>. Every harness is on <a className="lnk" href="https://github.com/ChainBench/OpenChainBench/tree/main/harnesses" rel="noopener">GitHub under harnesses/</a>. Clone, run <code>docker compose up</code>, your <code>/metrics</code> endpoint emits the same numbers ours does within 30 seconds.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Public methodology review</strong>. We invite external review and ship the fixes publicly. In June 2026 the Coinpaprika data team flagged four issues on the stablecoin peg and oracle deviation benches. We shipped three of them in pull requests <a className="lnk" href="https://github.com/ChainBench/OpenChainBench/pull/349" rel="noopener">#349</a>, <a className="lnk" href="https://github.com/ChainBench/OpenChainBench/pull/352" rel="noopener">#352</a> and <a className="lnk" href="https://github.com/ChainBench/OpenChainBench/pull/353" rel="noopener">#353</a> within twenty-four hours and pushed back on the fourth with citations to CME, Chainlink and CoinGecko convention.</span></li>
      </ul>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        We do not run a paid tier. We do not sell ranking slots. We do not take provider sponsorship in exchange for inclusion. There is no token. If you spot any deviation from this policy, file a <a className="lnk" href="https://github.com/ChainBench/OpenChainBench/security/advisories/new" rel="noopener">private security advisory</a> and we will treat it as the integrity incident it would be.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        Hosting and infrastructure costs are paid by Mobula. The site runs on Vercel; harnesses run on Railway. We are open to grant funding that preserves editorial independence, but we will not accept funding from any party we benchmark.
      </p>

      <SectionRule label="How it works" number="iv" />
      <p className="text-base leading-relaxed text-ink-soft">
        Every benchmark is a YAML spec plus a harness. The spec describes what to measure, which providers, which Prometheus queries hold the numbers; the harness runs continuously on Railway and exposes those metrics. A single shared Prometheus scrapes every harness; the site queries Prometheus directly and re-renders every minute. Every provider is rendered with equal visual weight. readers do their own ranking.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        Anyone can submit a benchmark. The{" "}
        <Link className="lnk" href="/contribute">contribution guide</Link>{" "}
        walks through the steps. New providers, new metrics, new chains. all welcome via pull request.
      </p>

      <SectionRule label="What you can do" number="v" />
      <ul className="space-y-4 text-base leading-relaxed text-ink-soft">
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Read</strong> the{" "}<Link className="lnk" href="/#latest">live benchmarks</Link>{" "}.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Reproduce</strong> any number. the{" "}<Link className="lnk" href="/methodology">methodology</Link>{" "}page tells you how.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Contribute</strong> a harness via{" "}<a className="lnk" href="https://github.com/ChainBench/OpenChainBench">GitHub</a>. Pull requests for new providers and new benchmarks are reviewed openly.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Discuss</strong> ideas in{" "}<a className="lnk" href="https://github.com/ChainBench/OpenChainBench/discussions">GitHub Discussions</a>{" "}or follow{" "}<a className="lnk" href="https://x.com/OpenChainBench">@OpenChainBench</a>.</span></li>
      </ul>

      <SectionRule label="Contact" number="vi" />
      <p className="text-base leading-relaxed text-ink-soft">
        See a number you can&apos;t reproduce? File a{" "}
        <a className="lnk" href="https://github.com/ChainBench/OpenChainBench/issues/new/choose">
          data-quality issue or a provider correction
        </a>
        . Material errors are corrected in place with a dated note on the affected report.
      </p>
    </article>
  );
}
