import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/page-metadata";
import { RpcMapClient } from "@/components/speedtest/rpc-map-client";
import { buildBreadcrumbJsonLd, safeJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

export const metadata: Metadata = pageMetadata({
  path: "/rpc-map",
  title: "Global RPC Latency Map: real measurements from real connections",
  description:
    "World map of RPC provider latency, built from anonymous browser speed tests run by real visitors. See which provider is fastest near you, per chain. Open data, CC-BY-4.0.",
});

export const revalidate = 3600;

export default function RpcMapPage() {
  const pageUrl = `${SITE.url}/rpc-map`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      buildBreadcrumbJsonLd([
        { name: "Home", item: SITE.url },
        { name: "RPC Latency Map", item: pageUrl },
      ]),
      {
        "@type": "Dataset",
        "@id": `${pageUrl}#dataset`,
        name: "Crowdsourced RPC latency by location",
        url: pageUrl,
        description:
          "Median RPC latency per provider per geographic area, aggregated from anonymous browser speed tests. No IPs stored; coordinates rounded to city-level cells.",
        license: "https://creativecommons.org/licenses/by/4.0/",
        creator: { "@id": `${SITE.url}/#org` },
        distribution: {
          "@type": "DataDownload",
          encodingFormat: "application/json",
          contentUrl: `${SITE.url}/api/speedtest/map`,
        },
      },
    ],
  };

  return (
    <article className="mx-auto max-w-[1100px] px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      <p className="font-sans text-[11px] uppercase tracking-[0.18em] text-ink-faint mb-3">
        RPC latency map
      </p>
      <h1 className="display text-3xl sm:text-5xl text-ink leading-[1.05]">
        Where is each RPC provider actually fast?
      </h1>
      <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
        Every dot is real measurements from real visitors who ran the{" "}
        <Link href="/speedtest-rpc" className="lnk">
          browser speed test
        </Link>{" "}
        at that location. Hover a dot to see which provider wins there and by
        how many milliseconds. Datacenter benchmarks tell you how fast a
        provider can be; this map shows what people actually experience.
      </p>
      <p className="mt-2 text-sm text-ink-faint">
        Fully anonymous: no IPs stored, locations rounded to city-level
        cells, provider names only (never URLs or keys). Medians and per-area
        caps keep any single source from tilting the map.
      </p>

      <RpcMapClient />

      <section className="mt-14 border-t border-rule pt-6 text-[13px] text-ink-soft leading-relaxed max-w-2xl">
        <p className="label-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint mb-3">
          How the map is built
        </p>
        <p>
          When a visitor completes a{" "}
          <Link href="/speedtest-rpc" className="lnk">
            speed test
          </Link>
          , the browser sends only the provider slug, the chain and the
          measured median. The server derives a city-level position from the
          request and immediately discards the address. Results aggregate
          into ~40 km cells; each cell shows the median of its last
          contributions over a rolling two-month window, with per-source
          daily caps so no single machine can flood an area. The dataset is
          available as{" "}
          <a href="/api/speedtest/map?chain=ethereum" className="lnk">
            open JSON
          </a>{" "}
          under CC-BY-4.0.
        </p>
      </section>
    </article>
  );
}
