import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/page-metadata";
import { SpeedtestRpcClient } from "@/components/speedtest/speedtest-rpc-client";
import { buildBreadcrumbJsonLd, safeJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

export const metadata: Metadata = pageMetadata({
  path: "/speedtest-rpc",
  title: "RPC Speed Test — benchmark your endpoints from your browser",
  description:
    "Paste any RPC URLs and measure their real latency from your own connection. Same anti-cache methodology as our public benchmarks. No install, no signup — your URLs and API keys never leave your browser.",
});

export const revalidate = 3600;

export default function SpeedtestRpcPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      buildBreadcrumbJsonLd([
        { name: "Home", item: SITE.url },
        { name: "RPC Speed Test", item: `${SITE.url}/speedtest-rpc` },
      ]),
      {
        "@type": "WebApplication",
        "@id": `${SITE.url}/speedtest-rpc#app`,
        name: "RPC Speed Test",
        url: `${SITE.url}/speedtest-rpc`,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Web",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        description:
          "Browser-based latency test for JSON-RPC endpoints. Probes run directly from the visitor's connection with the same anti-cache methodology as OpenChainBench's public benchmarks; endpoint URLs never reach OpenChainBench servers.",
        publisher: { "@id": `${SITE.url}/#org` },
      },
    ],
  };

  return (
    <article className="mx-auto max-w-[840px] px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      <p className="font-sans text-[11px] uppercase tracking-[0.18em] text-ink-faint mb-3">
        RPC speed test
      </p>
      <h1 className="display text-3xl sm:text-5xl text-ink leading-[1.05]">
        Benchmark your RPC endpoints, from your connection
      </h1>
      <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
        Paste any JSON-RPC URLs — public gateways or your own keyed endpoints —
        pick a duration, and watch them race. Every probe fires directly from
        your browser with the same anti-cache payload as our{" "}
        <Link href="/rpc" className="lnk">
          public RPC benchmarks
        </Link>
        , so the numbers are comparable to the leaderboards.
      </p>
      <p className="mt-2 text-sm text-ink-faint">
        No install, no signup. Your URLs and API keys never leave this browser
        tab — requests go straight from you to the provider.
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
          staggered, randomized rounds until the clock runs out — request
          bursts never align and network wake-ups hit every endpoint evenly.
          Responses are classified ok / http_err / jsonrpc_err /
          timeout, and an endpoint reporting a block more than 20 behind the
          best tip in the same round is flagged stale. Latency percentiles use
          ok responses only, exactly like the{" "}
          <Link href="/methodology" className="lnk">
            public benchmark methodology
          </Link>
          . Results reflect your device, network and location — that is the
          point: it is the latency your application would actually see.
        </p>
      </section>
    </article>
  );
}
