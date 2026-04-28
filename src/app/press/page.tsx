import type { Metadata } from "next";
import { SectionRule } from "@/components/section-rule";

export const metadata: Metadata = {
  title: "Press kit",
  description:
    "Logos, boilerplate and contact details for journalists and partners.",
};

export default function PressPage() {
  return (
    <article className="px-4 pt-12 sm:pt-16">
      <div className="mx-auto max-w-3xl">
        <span className="eyebrow">Press kit</span>
        <h1 className="mt-5 display text-4xl sm:text-5xl">
          For journalists, podcasters and analysts.
        </h1>
        <p className="mt-5 text-lg text-ink-muted leading-relaxed">
          Use any chart, table or number from this site in editorial contexts — with attribution and a link to the source report. Charts shouldn&apos;t be cropped or re-coloured in a way that changes their meaning.
        </p>

        <SectionRule label="Boilerplate" />
        <blockquote className="card p-6 text-base leading-relaxed text-ink-soft">
          OpenChainBench is an open, reproducible benchmark series for crypto infrastructure. Each report measures latency, accuracy or reliability of one category — aggregators, bridges, RPCs, price feeds — and ships alongside the script that produced it. Methodology and raw data are public. The project is community-run and MIT-licensed.
        </blockquote>

        <SectionRule label="Quick facts" />
        <dl className="grid gap-px sm:grid-cols-2 bg-rule rounded-xl overflow-hidden border border-rule">
          <Fact term="Founded" value="2026" />
          <Fact term="Categories" value="Aggregators · Bridges · Data · RPCs" />
          <Fact term="Source code" value="github.com/OpenChainBench/OpenChainBench" />
          <Fact term="License" value="MIT (code) · CC-BY-4.0 (reports)" />
        </dl>

        <SectionRule label="Contact" />
        <p className="text-base leading-relaxed text-ink-soft">
          For interviews, custom benchmark requests or pre-publication embargoes — open an issue or a discussion on{" "}
          <a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench">GitHub</a>.
        </p>
      </div>
    </article>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="bg-bg-elev px-5 py-4">
      <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
        {term}
      </dt>
      <dd className="mt-1 text-sm text-ink">{value}</dd>
    </div>
  );
}
