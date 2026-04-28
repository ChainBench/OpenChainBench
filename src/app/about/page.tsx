import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SectionRule } from "@/components/section-rule";

export const metadata: Metadata = {
  title: "About",
  description: "Why OpenChainBench exists and how it stays honest.",
};

export default function AboutPage() {
  return (
    <article className="px-4 pt-12 sm:pt-16">
      <div className="mx-auto max-w-3xl">
        <span className="eyebrow">About</span>
        <h1 className="mt-5 display text-4xl sm:text-5xl">
          Open performance data for the multichain stack.
        </h1>
        <p className="mt-5 text-lg text-ink-muted leading-relaxed">
          A small editorial team and a rotating set of contributors publish one benchmark at a time, each shipping with the script that produced it. The goal is to make performance an observable property of crypto infrastructure — like uptime is for SaaS, or p99 is for databases.
        </p>

        <SectionRule label="Why this exists" />
        <p className="text-base leading-relaxed text-ink-soft">
          Crypto infrastructure runs the world&apos;s open financial rails, and almost none of it is benchmarked in public. Every aggregator, bridge and market-data feed quotes its own numbers, on its own terms, with its own regions and its own definitions of &ldquo;fast&rdquo;.
        </p>
        <p className="mt-4 text-base leading-relaxed text-ink-soft">
          OpenChainBench picks one definition at a time, runs the experiment in the open, and publishes the script alongside the result. We don&apos;t aim to embarrass anyone; we aim to make performance a thing you can compare on data, not on marketing copy.
        </p>

        <SectionRule label="How it works" />
        <p className="text-base leading-relaxed text-ink-soft">
          Every benchmark is a YAML spec plus a harness. The spec describes what to measure, which providers, which Prometheus queries hold the numbers; the harness runs continuously and pushes metrics. The site re-queries every minute and re-renders. The leader on every page is computed live from the data.
        </p>
        <p className="mt-4 text-base leading-relaxed text-ink-soft">
          Anyone can submit a benchmark. The{" "}
          <Link className="lnk" href="/contribute">tutorial</Link>{" "}
          walks through the four steps. New providers, new metrics, new chains — all welcome via pull request.
        </p>

        <SectionRule label="What you can do" />
        <ul className="space-y-3.5">
          <ActionRow href="/benchmarks" label="Read the back-catalogue" sub="Every published benchmark." />
          <ActionRow href="/methodology" label="Reproduce any number" sub="Methodology, harnesses, expected sample sizes." />
          <ActionRow href="https://github.com/OpenChainBench/OpenChainBench" label="Contribute on GitHub" sub="Pull requests for new providers and benchmarks welcome." external />
          <ActionRow href="https://twitter.com/openchainbench" label="Follow @openchainbench" sub="New issues, charts, and corrections." external />
        </ul>

        <SectionRule label="Get in touch" />
        <p className="text-base leading-relaxed text-ink-soft">
          Bug in a number? Open an issue on{" "}
          <a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/issues/new">GitHub</a>
          . For everything else, the GitHub repo is the place — discussions, PRs and proposals all go through it.
        </p>
      </div>
    </article>
  );
}

function ActionRow({
  href,
  label,
  sub,
  external,
}: {
  href: string;
  label: string;
  sub: string;
  external?: boolean;
}) {
  const cn =
    "group flex items-start justify-between gap-6 border-b border-rule py-5 -mx-3 px-3 rounded-lg hover:bg-bg-soft transition-colors";
  const content = (
    <>
      <div>
        <p className="text-base font-medium text-ink">{label}</p>
        <p className="mt-1 text-sm text-ink-muted">{sub}</p>
      </div>
      <ArrowUpRight
        size={16}
        strokeWidth={2}
        className="text-ink-muted group-hover:text-ink shrink-0 mt-1.5"
      />
    </>
  );
  return (
    <li>
      {external ? (
        <a href={href} className={cn}>{content}</a>
      ) : (
        <Link href={href} className={cn}>{content}</Link>
      )}
    </li>
  );
}
