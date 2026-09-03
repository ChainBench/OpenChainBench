import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { pageMetadata } from "@/lib/page-metadata";
import { SpeedtestRpcClient } from "@/components/speedtest/speedtest-rpc-client";
import { buildBreadcrumbJsonLd, buildFaqPageJsonLd, safeJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

// Long-lived branch link: the probe engine ships in the site bundle, so
// pointing at the source file IS the full disclosure of what runs in the
// visitor's browser.
const SOURCE_URL =
  "https://github.com/ChainBench/OpenChainBench/blob/dev/src/components/speedtest/speedtest-rpc-client.tsx";

const FAQ = [
  {
    q: "Is it safe to paste an RPC URL with my API key?",
    a: "Yes. Every probe fires directly from your browser to the provider. Your URLs and keys are never sent to OpenChainBench servers, never logged, and never leave the browser tab. The probe engine is open source, so you can verify exactly what runs.",
  },
  {
    q: "Why do my numbers differ from the public benchmark pages?",
    a: "The public benchmarks probe from fixed datacenter regions every 60 seconds around the clock. This tool measures from your device, your network and your location right now. Both use the same anti-cache probe and classification, so the numbers are comparable, but the vantage point is yours. That is the point: it is the latency your application would actually see.",
  },
  {
    q: "Which chains and endpoints can I test?",
    a: "Any HTTPS JSON-RPC endpoint that speaks the standard eth_ methods, on any EVM chain: public gateways, your own keyed Alchemy, Chainstack or QuickNode URLs, or a self-hosted node with CORS enabled. The chain picker prefills the exact no-key cohort that the public per-chain benchmarks rank, across 87 EVM chains.",
  },
  {
    q: "Why does an endpoint show as browser-blocked?",
    a: "Some endpoints do not send CORS headers, so browsers refuse to call them. This is a property of the endpoint, not of the test: dapps cannot call those endpoints from a browser either. The tool shows an equivalent curl command so you can measure them from a terminal, and the public benchmarks cover them from datacenter probes.",
  },
];

const baseMetadata = pageMetadata({
  path: "/speedtest-rpc",
  title: "RPC Speed Test: benchmark your endpoints from your browser",
  description:
    "Free online RPC latency test. Paste any RPC URLs and measure their real speed from your own connection, across 87 EVM chains. No install, no signup, keys never leave your browser.",
});

// pageMetadata pins the generic root card; point socials at the
// dedicated dial card rendered by ./opengraph-image.tsx instead.
const OG_IMAGE = {
  url: `${SITE.url}/speedtest-rpc/opengraph-image`,
  width: 1200,
  height: 630,
};
export const metadata: Metadata = {
  ...baseMetadata,
  openGraph: { ...baseMetadata.openGraph, images: [OG_IMAGE] },
  twitter: { ...baseMetadata.twitter, images: [OG_IMAGE.url] },
};

export const revalidate = 3600;

export default function SpeedtestRpcPage() {
  const pageUrl = `${SITE.url}/speedtest-rpc`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      buildBreadcrumbJsonLd([
        { name: "Home", item: SITE.url },
        { name: "RPC Speed Test", item: pageUrl },
      ]),
      {
        "@type": "WebApplication",
        "@id": `${pageUrl}#app`,
        name: "RPC Speed Test",
        url: pageUrl,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Web",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        description:
          "Browser-based latency test for JSON-RPC endpoints. Probes run directly from the visitor's connection with the same anti-cache methodology as OpenChainBench's public benchmarks; endpoint URLs never reach OpenChainBench servers.",
        publisher: { "@id": `${SITE.url}/#org` },
        // E-E-A-T + GEO: the exact code that runs in the visitor's
        // browser is public.
        isBasedOn: SOURCE_URL,
        license: "https://github.com/ChainBench/OpenChainBench/blob/main/LICENSE",
      },
    ],
  };
  const faqJsonLd = buildFaqPageJsonLd(
    FAQ,
    pageUrl,
    null,
    "RPC Speed Test: frequently asked questions",
  );

  return (
    <article className="mx-auto max-w-[840px] px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      {faqJsonLd && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(faqJsonLd) }}
        />
      )}
      <p className="font-sans text-[11px] uppercase tracking-[0.18em] text-ink-faint mb-3">
        RPC speed test
      </p>
      <h1 className="display text-3xl sm:text-5xl text-ink leading-[1.05]">
        Benchmark your RPC endpoints, from your connection
      </h1>
      <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
        Paste any JSON-RPC URLs, public gateways or your own keyed endpoints,
        then pick a duration, and watch them race. Every probe fires directly from
        your browser with the same anti-cache payload as our{" "}
        <Link href="/rpc" className="lnk">
          public RPC benchmarks
        </Link>
        , so the numbers are comparable to the leaderboards.
      </p>
      <p className="mt-2 text-sm text-ink-faint">
        No install, no signup. Your URLs and API keys never leave this browser
        tab. Requests go straight from you to the provider.{" "}
        <a href={SOURCE_URL} className="lnk" rel="noopener noreferrer" target="_blank">
          The probe engine is open source
          <ArrowUpRight size={11} strokeWidth={2} className="inline ml-0.5 align-baseline" />
        </a>{" "}
        so you can verify exactly what runs.
      </p>

      <SpeedtestRpcClient />

      <section className="mt-14 border-t border-rule pt-6 text-[13px] text-ink-soft leading-relaxed max-w-2xl">
        <p className="label-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint mb-3">
          Methodology
        </p>
        <p>
          Each endpoint receives an identical{" "}
          <code className="font-mono text-[12px]">
            eth_getBlockByNumber(&quot;latest&quot;, false)
          </code>{" "}
          POST with a rotating request id, so no edge cache can answer without
          touching a real node. One warmup request absorbs the TCP + TLS
          handshake, then all endpoints are probed once per second in
          staggered, randomized rounds until the clock runs out, so request
          bursts never align and network wake-ups hit every endpoint evenly.
          Responses are classified ok / http_err / jsonrpc_err /
          timeout, and an endpoint reporting a block more than 20 behind the
          best tip in the same round is flagged stale. Latency percentiles use
          ok responses only, exactly like the{" "}
          <Link href="/methodology" className="lnk">
            public benchmark methodology
          </Link>
          . Results reflect your device, network and location. That is the
          point: it is the latency your application would actually see.
        </p>
        <p className="mt-3">
          Everything on this page is open source:{" "}
          <a href={SOURCE_URL} className="lnk" rel="noopener noreferrer" target="_blank">
            browser probe engine
          </a>{" "}
          and the{" "}
          <a
            href="https://github.com/ChainBench/OpenChainBench/tree/main/harnesses/rpc-capabilities"
            className="lnk"
            rel="noopener noreferrer"
            target="_blank"
          >
            rpc-capabilities harness
          </a>{" "}
          that runs the same probe from datacenters for the public
          leaderboards.
        </p>
      </section>

      {/* FAQ: visible text mirrors the FAQPage JSON-LD, as Google requires. */}
      <section className="mt-12 max-w-2xl">
        <h2 className="display text-2xl tracking-tight text-ink">
          Frequently asked
        </h2>
        <div className="mt-5 space-y-3">
          {FAQ.map((item) => (
            <details
              key={item.q}
              className="group card-soft rounded-lg px-5 py-4 [&_summary]:cursor-pointer [&_summary::-webkit-details-marker]:hidden [&_summary]:list-none"
            >
              <summary className="text-[15px] font-semibold text-ink">
                {item.q}
              </summary>
              <p className="mt-2.5 text-sm leading-relaxed text-ink-soft">{item.a}</p>
            </details>
          ))}
        </div>
      </section>
    </article>
  );
}
