import type { Metadata } from "next";
import { SectionRule } from "@/components/section-rule";

export const metadata: Metadata = {
  title: "Press kit",
  description: "Logos, boilerplate and contact details for journalists and partners.",
};

export default function PressPage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12">
      <header className="border-b-2 border-ink pb-6">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">Press kit</h1>
        <p className="mt-3 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
          For journalists, podcasters and analysts covering crypto-infra performance.
        </p>
      </header>

      <SectionRule label="Boilerplate" number="i" />
      <blockquote className="border-l-4 border-ink pl-6 py-2 text-base leading-relaxed text-ink-soft">
        OpenChainBench is an open, reproducible benchmark series for crypto infrastructure. Each report measures latency, accuracy or reliability of one category. aggregators, bridges, RPCs, price feeds. and ships alongside the script that produced it. Methodology, specs and raw metrics are public. The project is community-run and MIT-licensed.
      </blockquote>

      <SectionRule label="Quick facts" number="ii" />
      <dl className="grid gap-3 sm:grid-cols-2 ">
        <Fact term="Founded" value="2026" />
        <Fact term="Categories" value="Aggregators · Blockchains · Bridges · Trading · Wallets · RPCs" />
        <Fact term="Source code" value="github.com/OpenChainBench/OpenChainBench" />
        <Fact term="License" value="MIT (code) · CC-BY-4.0 (reports)" />
      </dl>

      <SectionRule label="Use of figures" number="iii" />
      <p className="text-base leading-relaxed text-ink-soft">
        All charts and tables on this site are free to reproduce in editorial contexts with attribution to OpenChainBench and a link to the source report. Please don&apos;t crop charts in a way that changes their meaning.
      </p>

      <SectionRule label="Contact" number="iv" />
      <p className="text-base leading-relaxed text-ink-soft">
        For interviews, custom benchmark requests or pre-publication embargoes. open an issue or a discussion on{" "}
        <a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench">GitHub</a>.
      </p>
    </article>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="border-y border-rule py-3">
      <dt className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-muted">{term}</dt>
      <dd className="mt-1 text-base font-medium">{value}</dd>
    </div>
  );
}
