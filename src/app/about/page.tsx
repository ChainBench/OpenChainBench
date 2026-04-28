import type { Metadata } from "next";
import Link from "next/link";
import { SectionRule } from "@/components/section-rule";
import { SPONSOR } from "@/data/site";

export const metadata: Metadata = {
  title: "About",
  description: "Why OpenChainBench exists, who runs it, and how it stays honest.",
};

export default function AboutPage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12">
      <p className="font-sans text-[11px] uppercase tracking-[0.22em] text-accent">
        Editorial · Standing Note
      </p>
      <h1 className="mt-3 font-serif text-5xl font-bold tracking-tight">
        About this journal
      </h1>
      <p className="mt-4 font-serif italic text-xl text-ink-soft">
        A field journal for crypto-infrastructure performance — measured in the
        open, published in the same format every time.
      </p>

      <SectionRule label="Why" number="i" />
      <p className="font-serif text-[1.08rem] leading-[1.7] dropcap">
        Crypto infrastructure runs the world's open financial rails, and almost
        none of it is benchmarked in public. Every aggregator, bridge and
        market-data feed quotes its own numbers, on its own terms, with its
        own regions and its own definitions of "fast". OpenChainBench picks
        one definition at a time, runs the experiment in the open, and
        publishes the script alongside the result.
      </p>
      <p className="mt-4 font-serif text-[1.05rem] leading-[1.65]">
        The goal is not to embarrass anyone. The goal is to make performance
        an observable property of crypto infrastructure — like uptime in SaaS,
        or p99 in databases — so builders can choose providers on data and
        users can hold them to it.
      </p>

      <SectionRule label="Who" number="ii" />
      <p className="font-serif text-[1.05rem] leading-[1.65]">
        OpenChainBench is published by a small editorial team and a rotating
        set of contributors who write the harnesses. The project is sponsored
        by{" "}
        <Link className="lnk" href="https://mobula.io">
          {SPONSOR.name}
        </Link>
        , an aggregator and market-data API that appears in several of our
        benchmarks.
      </p>
      <p className="mt-4 font-serif text-[1.05rem] leading-[1.65]">
        {SPONSOR.note}
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
            <strong>Contribute</strong> a harness via{" "}
            <a className="lnk" href="https://github.com/mobula/openchainbench">
              GitHub
            </a>
            . We accept pull requests for new providers and new benchmarks.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-ink-muted">—</span>
          <span>
            <strong>Subscribe</strong> on{" "}
            <a className="lnk" href="https://twitter.com/openchainbench">Twitter</a>{" "}
            or{" "}
            <a className="lnk" href="https://reddit.com/r/openchainbench">Reddit</a>{" "}
            to see new issues as they ship.
          </span>
        </li>
      </ul>

      <SectionRule label="Contact" number="iv" />
      <p className="font-serif text-[1.05rem] leading-[1.65]">
        Editorial:{" "}
        <a className="lnk" href="mailto:editor@openchainbench.xyz">
          editor@openchainbench.xyz
        </a>
        <br />
        Press &amp; partnerships:{" "}
        <a className="lnk" href="mailto:press@openchainbench.xyz">
          press@openchainbench.xyz
        </a>
        <br />
        Bug in a number?{" "}
        <a className="lnk" href="https://github.com/mobula/openchainbench/issues/new">
          File an issue
        </a>
        .
      </p>
    </article>
  );
}
