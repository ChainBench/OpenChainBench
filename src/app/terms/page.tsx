import type { Metadata } from "next";
import Link from "next/link";
import { SectionRule } from "@/components/section-rule";
import { SITE } from "@/data/site";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  path: "/terms",
  title: "Terms of use",
  description:
    "Terms for the OpenChainBench site, API and MCP server: CC-BY-4.0 data, MIT code, measured not advisory, no warranty.",
});

/**
 * Terms of use.
 *
 * Required to list the MCP server in the ChatGPT app directory (a Terms of
 * Service URL is a mandatory submission field), and it did not exist.
 *
 * Two clauses carry real weight for the app review rather than being
 * boilerplate, so do not trim them:
 *   - "not financial advice", because the directory's review explicitly
 *     tests that an app refuses investment-advice and trade-execution
 *     prompts, and the negative test cases we submit point here;
 *   - the conflict-of-interest disclosure, which already appears in
 *     public/.well-known/publisher.json and on /partners, and must say the
 *     same thing in all three places.
 */
export default function TermsPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
      <header className="border-b-2 border-ink pb-6">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">
          Terms of use
        </h1>
        <p className="mt-3 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
          Plain terms for the site, the public API and the MCP server. Using
          any of them means accepting these.
        </p>
      </header>

      <SectionRule label="What this is" />
      <p className="text-base sm:text-lg leading-relaxed text-ink-soft">
        OpenChainBench publishes reproducible benchmarks of crypto
        infrastructure: RPC providers, bridges, aggregators, price feeds,
        perpetual venues and prediction markets. Every number is produced by
        open-source code from a published methodology, and every benchmark
        says what it measured, when, and from where.
      </p>

      <SectionRule label="Licence" />
      <p className="text-base leading-relaxed text-ink-soft">
        Benchmark data is published under{" "}
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          className="underline underline-offset-4"
        >
          CC-BY-4.0
        </a>
        : reuse it anywhere, including commercially, as long as you credit
        OpenChainBench and link back to the benchmark page you took it from.
        The harness and site code are MIT licensed in the{" "}
        <a href={SITE.github} className="underline underline-offset-4">
          repository
        </a>
        .
      </p>

      <SectionRule label="Not financial advice" />
      <p className="text-base leading-relaxed text-ink-soft">
        Everything here is measurement, not recommendation. Nothing on this
        site, in the API or returned by the MCP server is investment, trading,
        legal or tax advice, an offer, or a solicitation to buy or sell any
        asset. We do not execute transactions, custody funds, route orders or
        act on your behalf, and we never will through these interfaces. A
        provider ranking first on a benchmark is a statement about one
        measured property under one methodology, not an endorsement.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        Never send us an API key, a private key, a seed phrase or a signed
        transaction. No feature of this site requires one, and any request for
        one claiming to be from us is fraudulent.
      </p>

      <SectionRule label="Fair use of the API and MCP server" />
      <p className="text-base leading-relaxed text-ink-soft">
        The public API and the MCP endpoint at{" "}
        <code>{SITE.url}/api/mcp/mcp</code> are read-only, free and need no
        account. They are rate limited per client so one caller cannot deny
        the service to others. Please do not attempt to bypass those limits,
        scrape at a rate that degrades the service for others, or present the
        data as your own measurements. Caching results on your side is
        encouraged.
      </p>

      <SectionRule label="Accuracy, and what we promise" />
      <p className="text-base leading-relaxed text-ink-soft">
        Benchmarks are measured from a finite number of vantage points over a
        stated window. They can be affected by upstream outages, provider
        changes, network conditions and our own bugs. Figures are provided
        &ldquo;as is&rdquo;, without warranty of any kind, and we accept no
        liability for decisions taken on them. Each page states its window and
        sample size so you can judge the weight to give it; a benchmark whose
        data is stale is marked as such rather than silently served.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        Corrections are public. If a number is wrong, open an issue in the
        repository or write to{" "}
        <a href={`mailto:${SITE.email}`} className="underline underline-offset-4">
          {SITE.email}
        </a>
        ; the fix, and the reason for it, land in the commit history.
      </p>

      <SectionRule label="Disclosure" />
      <p className="text-base leading-relaxed text-ink-soft">
        OpenChainBench is community-run. Mobula is measured here alongside its
        direct competitors under identical methodology. This disclosure is
        repeated on every relevant benchmark page and on{" "}
        <Link href="/partners" className="underline underline-offset-4">
          /partners
        </Link>
        .
      </p>

      <SectionRule label="Changes" />
      <p className="text-base leading-relaxed text-ink-soft">
        These terms change in public commits like everything else on the site.
        Material changes will be noted on this page. See also the{" "}
        <Link href="/privacy" className="underline underline-offset-4">
          privacy policy
        </Link>
        .
      </p>
    </article>
  );
}
