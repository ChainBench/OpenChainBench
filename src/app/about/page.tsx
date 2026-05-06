import type { Metadata } from "next";
import Link from "next/link";
import { SectionRule } from "@/components/section-rule";

export const metadata: Metadata = {
  title: "About",
  description: "Why OpenChainBench exists and how it stays honest.",
};

export default function AboutPage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="display text-3xl sm:text-4xl">
        About OpenChainBench
      </h1>
      <p className="mt-4 text-xl sm:text-2xl text-ink-muted leading-snug">
        Open, reproducible benchmarks for crypto infrastructure. measured in
        the open, published in the same format every time.
      </p>

      <SectionRule label="Why" number="i" />
      <p className="text-base sm:text-lg leading-relaxed text-ink-soft">
        Crypto infrastructure runs the world&apos;s open financial rails, and almost none of it is benchmarked in public. Every aggregator, bridge and market-data feed quotes its own numbers, on its own terms, with its own regions and its own definitions of &ldquo;fast&rdquo;. OpenChainBench picks one definition at a time, runs the experiment in the open, and publishes the script alongside the result.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        The goal is to make performance an observable property of crypto infrastructure. like uptime in SaaS, or p99 in databases. so builders can choose providers on data and users can hold them to it.
      </p>

      <SectionRule label="How" number="ii" />
      <p className="text-base leading-relaxed text-ink-soft">
        Every benchmark is a YAML spec plus a harness. The spec describes what to measure, which providers, which Prometheus queries hold the numbers; the harness runs continuously and exposes those metrics. A single shared Prometheus scrapes every harness; the site queries Prometheus directly and re-renders every minute. Every provider is rendered with equal visual weight. readers do their own ranking.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        Anyone can submit a benchmark. The{" "}
        <Link className="lnk" href="/contribute">contribution guide</Link>{" "}
        walks through the steps. New providers, new metrics, new chains. all welcome via pull request.
      </p>

      <SectionRule label="What you can do" number="iii" />
      <ul className="space-y-4 text-base leading-relaxed text-ink-soft">
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Read</strong> the{" "}<Link className="lnk" href="/benchmarks">live benchmarks</Link>{" "}.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Reproduce</strong> any number. the{" "}<Link className="lnk" href="/methodology">methodology</Link>{" "}page tells you how.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Contribute</strong> a harness via{" "}<a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench">GitHub</a>. Pull requests for new providers and new benchmarks are reviewed openly.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span><strong>Discuss</strong> ideas in{" "}<a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/discussions">GitHub Discussions</a>{" "}or follow{" "}<a className="lnk" href="https://twitter.com/openchainbench">@openchainbench</a>.</span></li>
      </ul>

      <SectionRule label="Contact" number="iv" />
      <p className="text-base leading-relaxed text-ink-soft">
        See a number you can&apos;t reproduce? File a{" "}
        <a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/issues/new/choose">
          data-quality issue or a provider correction
        </a>
        . Material errors are corrected in place with a dated note on the affected report.
      </p>
    </article>
  );
}
