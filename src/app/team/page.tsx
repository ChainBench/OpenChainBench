import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SectionRule } from "@/components/section-rule";
import { teamPageLd } from "@/lib/hub-jsonld";
import { safeJsonLd } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  path: "/team",
  title: "Team",
  description:
    "Who maintains OpenChainBench: spec review, harness design, statistical review and editorial corrections.",
});

export default function TeamPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
      {teamPageLd().map((ld, i) => (
        <script
          key={i}
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(ld) }}
        />
      ))}
      <header className="border-b-2 border-ink pb-6">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">Team</h1>
        <p className="mt-3 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
          A named maintainer signs off on every spec, every harness change,
          every statistical revision. Numbers on the site are attributable to
          a human, not a pipeline.
        </p>
      </header>

      <SectionRule label="Maintainer" number="i" />
      <section className="card-soft rounded-xl p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="display text-xl sm:text-2xl tracking-tight text-ink">
            Florent Tapponnier
          </h2>
          <p className="font-sans text-[11px] uppercase tracking-[0.16em] text-ink-muted font-medium">
            Maintainer
          </p>
        </div>
        <p className="mt-4 text-base leading-relaxed text-ink-soft">
          Owns spec review (the YAML contract that governs what a bench
          measures), harness design (the code that emits the metrics),
          statistical review (percentile choice, window sizing, sample-size
          floors) and editorial corrections (dated notes on the affected
          report when a number is challenged and found wrong).
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <a
            href="https://github.com/Flotapponnier"
            rel="noopener"
            className="inline-flex items-center gap-1.5 rounded-md card-soft px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
          >
            GitHub
            <ArrowUpRight size={12} strokeWidth={2} />
          </a>
          <a
            href="https://www.linkedin.com/in/florent-tapponnier-26324a17a/"
            rel="noopener"
            className="inline-flex items-center gap-1.5 rounded-md card-soft px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
          >
            LinkedIn
            <ArrowUpRight size={12} strokeWidth={2} />
          </a>
        </div>
      </section>

      <SectionRule label="Editorial policy" number="ii" />
      <p className="text-base leading-relaxed text-ink-soft">
        Every published benchmark ships with a spec, a harness reference and
        a set of Prometheus queries anyone can re-run. When a reader flags a
        number as wrong, the correction is applied in place with a dated
        note on the affected report, and the fix is shipped as a public pull
        request. The full policy, including how the statistical conventions
        are chosen and reviewed, lives on the{" "}
        <Link className="lnk" href="/methodology">methodology page</Link>.
      </p>

      <SectionRule label="Contact" number="iii" />
      <p className="text-base leading-relaxed text-ink-soft">
        For corrections, methodology questions or press, reach the
        maintainer at{" "}
        <a className="lnk" href="mailto:contact@openchainbench.com">
          contact@openchainbench.com
        </a>
        . Material errors are corrected in place with a dated note on the
        affected report.
      </p>
    </article>
  );
}
