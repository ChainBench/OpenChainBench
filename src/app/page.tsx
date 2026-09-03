import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getBenchmarksSafe } from "@/data/benchmarks";
import { HeroRadar } from "@/components/hero-radar";
import { HomeBenchTable } from "@/components/home-bench-table";
import { LiveDashboard } from "@/components/live/dashboard";
import { buildGlobalDatasetJsonLd } from "@/lib/dataset-jsonld";
import { safeJsonLd } from "@/lib/jsonld";

export const revalidate = 3600;

/**
 * Seed the live ticker with a real snapshot at ISR-regeneration time so
 * the numbers exist in the cached HTML (most AI crawlers don't run JS
 * and used to see dashes). Cost-neutral on Vercel: the fetch runs once
 * per Data-Cache window (60s) shared across ALL visitors, never
 * per-request — the page stays fully static/ISR. The client WebSocket
 * takes over within seconds of hydration.
 */
async function fetchRelayStats(): Promise<
  import("@/lib/live/types").GlobalView | null
> {
  try {
    const res = await fetch("https://stream.openchainbench.com/stats", {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { global?: Record<string, number> };
    const g = d.global;
    if (!g || typeof g.vol24h !== "number") return null;
    return {
      vol24h: g.vol24h,
      trades24h: g.trades24h ?? 0,
      buys24h: g.buys24h ?? 0,
      sells24h: g.sells24h ?? 0,
      fees24h: g.fees24h ?? 0,
      mcap: g.mcap ?? 0,
      byChain: [],
      lighthouseAt: g.lighthouseAt ?? 0,
      mcapAt: g.mcapAt ?? 0,
    };
  } catch {
    // Relay unreachable at regeneration time: render the pre-existing
    // dashes rather than fail the page.
    return null;
  }
}

const DESCRIPTION =
  "Live benchmarks for crypto infrastructure: RPC latency, bridge fees, L2 finality and price feed accuracy. Open methodology, updated continuously.";

export const metadata: Metadata = {
  title: "OpenChainBench. Open benchmarks for crypto infrastructure",
  description: DESCRIPTION,
  alternates: { canonical: "https://openchainbench.com/" },
  openGraph: {
    title: "OpenChainBench. Open benchmarks for crypto infrastructure",
    description: DESCRIPTION,
    url: "https://openchainbench.com/",
    type: "website",
    siteName: "OpenChainBench",
  },
  twitter: {
    card: "summary_large_image",
    title: "OpenChainBench. Open benchmarks for crypto infrastructure",
    description: DESCRIPTION,
    site: "@OpenChainBench",
  },
};

export default async function HomePage() {
  const benchmarks = await getBenchmarksSafe();
  const initialStats = await fetchRelayStats();

  // Same timestamp source the bench pages use for Dataset.dateModified:
  // the harness lastRunAt (real data timestamp, not build time). The
  // newest one across the catalog dates the site-wide Dataset node.
  const latestRunAt = benchmarks
    .map((b) => b.lastRunAt)
    .filter((iso) => iso && !Number.isNaN(new Date(iso).getTime()))
    .sort()
    .pop();

  return (
    <article className="mx-auto max-w-[1400px] px-4 sm:px-6 py-10 sm:py-14 space-y-14 sm:space-y-20">
      {/* Site-wide schema.org/Dataset entry. Points Google Dataset Search,
          Perplexity and other crawlers at the canonical /api/citable JSON
          index and the Hugging Face parquet mirror. The Organization +
          WebSite JSON-LD lives in <head> via layout.tsx; this Dataset
          block is page-scoped so home is the only place that claims to be
          the dataset landing page. */}
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{
          __html: safeJsonLd(buildGlobalDatasetJsonLd(latestRunAt)),
        }}
      />

      {/* Hero */}
      <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-8 lg:gap-12 items-center lg:pr-12">
        <div>
          <h1 className="display text-3xl sm:text-4xl md:text-5xl text-ink leading-[1.05]">
            Open-source KPIs from onchain products.
          </h1>
          <p className="mt-5 max-w-xl text-base text-ink-soft leading-snug">
            OpenChainBench runs continuous, reproducible benchmarks on crypto
            infrastructure: RPC providers, bridges, price feeds and data APIs.
            Open methodology, open harnesses, live data.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href="/benchmarks"
              className="inline-flex items-center gap-2 rounded-md bg-accent hover:bg-accent/90 text-white px-4 py-2.5 text-sm font-semibold tracking-wide uppercase transition-colors"
            >
              View all benchmarks
              <kbd className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] rounded text-[10px] font-mono bg-white/20 px-1">
                B
              </kbd>
            </Link>
            <Link
              href="/contribute"
              className="inline-flex items-center gap-2 rounded-md border border-rule-strong bg-surface hover:border-ink/40 text-ink px-4 py-2.5 text-sm font-semibold tracking-wide uppercase transition-colors"
            >
              Contribute
              <ArrowRight size={14} strokeWidth={2} />
            </Link>
          </div>
        </div>
        <div className="flex justify-center">
          <HeroRadar size={360} />
        </div>
      </section>

      {/* Live Network ecosystem */}
      <section>
        <header className="mb-5 sm:mb-7">
          <h2 className="display text-2xl sm:text-3xl text-ink">Network Ecosystem</h2>
          <p className="mt-2 max-w-2xl text-sm text-ink-soft leading-snug">
            Live stream of ecosystem data, transaction volumes, and network activity across
            supported chains.
          </p>
        </header>
        <LiveDashboard initialStats={initialStats} />
      </section>

      {/* Latest deployed benchmarks */}
      <HomeBenchTable benchmarks={benchmarks} />
    </article>
  );
}
