import type { Metadata } from "next";
import { SectionRule } from "@/components/section-rule";
import { pageMetadata } from "@/lib/page-metadata";
import { SITE } from "@/data/site";
import { withUtm } from "@/lib/utm";

export const metadata: Metadata = pageMetadata({
  path: "/contact",
  title: "Contact",
  description:
    "How to reach OpenChainBench: correct a number, correct your own provider entry, propose a benchmark, report an integrity problem, or ask about press and embeds.",
});

/**
 * One page that routes a request to the channel that answers it.
 *
 * The address existed before this page, in the footer and on three other
 * pages, and that was the whole system: every kind of request arrived in
 * one inbox with no context. Most of them have a better destination that
 * already exists. A wrong number belongs in the data-quality template,
 * where the form asks for the bench slug and the value; a provider
 * correcting their own entry belongs in the provider template, which asks
 * who they are; an integrity problem belongs in a private advisory rather
 * than in a public issue.
 *
 * Email stays last and unconditional. A contact page that only offers
 * forms is a contact page that turns people away, and the people most
 * worth hearing from are often the ones who will not open a GitHub
 * account to tell us we are wrong.
 */
const ROUTES = [
  {
    title: "A number on the site looks wrong",
    body: "Every figure is a query against a public Prometheus, so a wrong number is reproducible and worth a report. The template asks for the benchmark, the value you saw and what you expected, which is what makes it checkable.",
    href: "https://github.com/ChainBench/OpenChainBench/issues/new?template=data-quality.yml",
    cta: "Open a data-quality issue",
  },
  {
    title: "You are a provider and something about you is wrong",
    body: "Endpoint, plan tier, pricing, the description on your product page, or a cohort you believe you should be in. The template asks you to identify yourself so the correction can be attributed in the changelog.",
    href: "https://github.com/ChainBench/OpenChainBench/issues/new?template=provider-correction.yml",
    cta: "Open a provider correction",
  },
  {
    title: "You want a benchmark that does not exist",
    body: "Proposals go through an issue first so the metric, the providers and the methodology get reviewed before anyone writes a harness. Brainstorm-stage ideas belong in Discussions instead.",
    href: "https://github.com/ChainBench/OpenChainBench/issues/new?template=new-benchmark.yml",
    cta: "Propose a benchmark",
  },
  {
    title: "You think our independence has been compromised",
    body: "No paid tier, no sold ranking slots, no provider sponsorship in exchange for inclusion. If you spot a deviation from that, it is an integrity incident and it should not be filed in public first.",
    href: "https://github.com/ChainBench/OpenChainBench/security/advisories/new",
    cta: "File a private advisory",
  },
] as const;

export default function ContactPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
      <header className="border-b-2 border-ink pb-6">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">Contact</h1>
        <p className="mt-3 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
          Most requests have a destination that answers them faster than an inbox. The address at the bottom works for everything else.
        </p>
      </header>

      <SectionRule label="Pick the one that fits" />
      <ul className="space-y-6">
        {ROUTES.map((r) => (
          <li key={r.href} className="border-l-2 border-rule pl-5">
            <h3 className="text-base font-medium text-ink">{r.title}</h3>
            <p className="mt-1.5 text-[15px] text-ink-soft leading-relaxed">{r.body}</p>
            <a
              className="lnk mt-2 inline-block text-sm"
              href={withUtm(r.href)}
              rel="noopener noreferrer"
              target="_blank"
            >
              {r.cta}
            </a>
          </li>
        ))}
      </ul>

      <SectionRule label="Email" />
      <p className="text-[15px] text-ink-soft leading-relaxed">
        Press, embeds, partnerships, a correction you would rather not file in public, or anything that does not fit above.
      </p>
      <p className="mt-3">
        <a className="lnk text-lg" href={`mailto:${SITE.email}`}>
          {SITE.email}
        </a>
      </p>
      <p className="mt-3 text-[13px] text-ink-faint leading-relaxed">
        There is no form on this page on purpose: a form would put a database between you and us for no gain. Journalists will find the logos, the boilerplate and the quick facts on the{" "}
        <a className="lnk" href="/press">press kit</a>, and the embed and badge terms are on{" "}
        <a className="lnk" href="/partners">partners</a>.
      </p>

      <SectionRule label="What we cannot do" />
      <ul className="space-y-2 text-[15px] text-ink-soft leading-relaxed list-disc pl-5">
        <li>Move a provider up a leaderboard. The order is recomputed at render time from the measured values, and no one here can edit it.</li>
        <li>Remove a provider from a benchmark because the result is unflattering. A correction to the measurement is always welcome; a correction to the outcome is not a thing we have.</li>
        <li>Give support for a provider&apos;s product. We measure them from the outside and have no account with most of them.</li>
      </ul>
    </article>
  );
}
