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
      <p className="font-sans text-[11px] uppercase tracking-[0.22em] text-accent">
        Standing note
      </p>
      <h1 className="mt-3 font-serif text-5xl font-bold tracking-tight">
        About this journal
      </h1>
      <p className="mt-4 font-serif italic text-xl text-ink-soft">
        A field journal for crypto-infrastructure performance — measured in
        the open, published in the same format every time.
      </p>

      <SectionRule label="Why" number="i" />
      <p className="font-serif text-[1.08rem] leading-[1.7] dropcap">
        Crypto infrastructure runs the world&apos;s open financial rails, and
        almost none of it is benchmarked in public. Every aggregator, bridge
        and market-data feed quotes its own numbers, on its own terms, with
        its own regions and its own definitions of &ldquo;fast&rdquo;.
        OpenChainBench picks one definition at a time, runs the experiment in
        the open, and publishes the script alongside the result.
      </p>
      <p className="mt-4 font-serif text-[1.05rem] leading-[1.65]">
        The goal is not to embarrass anyone. The goal is to make performance
        an observable property of crypto infrastructure — like uptime in
        SaaS, or p99 in databases — so builders can choose providers on data
        and users can hold them to it.
      </p>

      <SectionRule label="How" number="ii" />
      <p className="font-serif text-[1.05rem] leading-[1.65]">
        Every benchmark is a YAML spec plus a harness. The spec describes
        what to measure, which providers, which Prometheus queries hold the
        numbers; the harness runs continuously and pushes metrics. The site
        re-queries every minute and re-renders. The leader on every page is
        computed live from the data — there is no pre-determined winner in
        any spec.
      </p>
      <p className="mt-4 font-serif text-[1.05rem] leading-[1.65]">
        Anyone can submit a benchmark. The{" "}
        <Link className="lnk" href="/contribute">
          tutorial
        </Link>{" "}
        walks through the four steps. New providers, new metrics, new
        chains — all welcome via pull request.
      </p>

      <SectionRule label="What you can do" number="iii" />
      <ul className="space-y-4 font-serif text-[1.05rem] leading-[1.65]">
        <li className="flex gap-3">
          <span className="text-ink-muted">—</span>
          <span>
            <strong>Read</strong> the{" "}
            <Link className="lnk" href="/benchmarks">
              full back-catalogue
            </Link>{" "}
            of reports.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-ink-muted">—</span>
          <span>
            <strong>Reproduce</strong> any number — the{" "}
            <Link className="lnk" href="/methodology">
              methodology
            </Link>{" "}
            page tells you how.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-ink-muted">—</span>
          <span>
            <strong>Submit</strong> a benchmark via{" "}
            <a
              className="lnk"
              href="https://github.com/Flotapponnier/OpenChainBench"
            >
              GitHub
            </a>
            . Pull requests for new providers, metrics and chains are all
            welcome.
          </span>
        </li>
      </ul>

      <SectionRule label="Contact" number="iv" />
      <p className="font-serif text-[1.05rem] leading-[1.65]">
        Bug in a number?{" "}
        <a
          className="lnk"
          href="https://github.com/Flotapponnier/OpenChainBench/issues/new"
        >
          File an issue
        </a>
        . For everything else, the GitHub repo is the place — discussions,
        PRs and proposals all go through it.
      </p>
    </article>
  );
}
