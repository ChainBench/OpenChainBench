import type { Metadata } from "next";
import Link from "next/link";
import { SectionRule } from "@/components/section-rule";
import { SITE } from "@/data/site";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  path: "/privacy",
  title: "Privacy",
  description:
    "What OpenChainBench collects, why, who processes it, how long it is kept, and what you can turn off. No accounts, no advertising, no data sold.",
});

/**
 * Privacy policy.
 *
 * Required to list the MCP server in the ChatGPT app directory, and the
 * review asks for five specific things: the categories of personal data
 * collected, the purposes of use, the categories of recipients, retention
 * timelines, and the controls offered to users. The sections below are
 * ordered to match, because the first version was written as prose and the
 * reviewer could not find them.
 *
 * Every figure is read off the running system rather than drafted from a
 * template. Two of them corrected the first version, which was wrong:
 *
 *   - It said no IP address is stored. That was true of the server-side
 *     capture (src/lib/analytics-server.ts sets no IP and disables person
 *     profiles) and false of the site as a whole: the browser SDK posts
 *     through /ingest and PostHog records the request IP on ingestion, with
 *     `anonymize_ips` off on this project. Checked 2026-10-01: an IP is
 *     present on 100% of events, and PostHog derives country and city from
 *     it. Understating collection is as wrong as overstating it.
 *   - It gave no retention period at all. The project's configured
 *     product-analytics retention is one year.
 *
 * Verified alongside: `autocapture: false` and `session_recording_opt_in:
 * false` on the project, so there is no automatic event capture and no
 * session replay. If any of that changes, this page changes in the same
 * commit.
 */
export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
      <header className="border-b-2 border-ink pb-6">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">Privacy</h1>
        <p className="mt-3 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
          OpenChainBench has no accounts, no sign-in and no payments. It
          measures infrastructure, not people. This page says exactly what is
          collected anyway, and what you can switch off.
        </p>
      </header>

      <SectionRule label="What is collected" />
      <p className="text-base sm:text-lg leading-relaxed text-ink-soft">
        Reading the site produces ordinary web analytics. The categories are:
      </p>
      <ul className="mt-4 space-y-2 text-base leading-relaxed text-ink-soft">
        <li>
          <strong className="text-ink">Your IP address</strong>, recorded by our
          analytics processor when a request arrives, and the approximate
          location it derives from that: country and city, nothing finer.
        </li>
        <li>
          <strong className="text-ink">Your browser and device</strong>: the
          user-agent string, screen size, and the page performance timings
          behind our Core Web Vitals.
        </li>
        <li>
          <strong className="text-ink">What you looked at</strong>: the pages
          you opened, the page you arrived from, and three deliberate actions,
          an outbound link click, a copy, and a site search.
        </li>
        <li>
          <strong className="text-ink">A random device identifier</strong>{" "}
          stored in your browser, so two pageviews can be recognised as one
          visit. It is tied to no identity, and we never call the function that
          would create a user profile.
        </li>
      </ul>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        Three machine-readable surfaces are counted on the server instead,
        because no browser renders them: the Markdown views,{" "}
        <code>/api/stat</code> and <code>/api/citable</code>. There the
        identifier is a daily hash of the requesting user agent, and no profile
        is created.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        We never ask for and never want: your name, your email, a wallet
        address, a private key, a seed phrase or an API key. No feature of this
        site requires one.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        Automatic event capture is off, so nothing is recorded except the
        events named above. Session recording is off: no replays, no heatmaps,
        no keystroke or form capture.
      </p>

      <SectionRule label="Why" />
      <ul className="space-y-2 text-base leading-relaxed text-ink-soft">
        <li>
          To know which benchmarks are read, so we work on the ones people use.
        </li>
        <li>
          To measure whether pages load well, which is what the performance
          timings are for.
        </li>
        <li>
          To rate limit the public API per address, so one caller cannot deny
          the service to everyone else.
        </li>
      </ul>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        Not for advertising, not for profiling, and not for building a picture
        of you across other sites. There is no advertising on this site and no
        cross-site tracking identifier.
      </p>

      <SectionRule label="Who else sees it" />
      <ul className="space-y-2 text-base leading-relaxed text-ink-soft">
        <li>
          <strong className="text-ink">PostHog</strong>, our analytics
          processor, hosted in the United States. Analytics are proxied through
          this site&rsquo;s own origin, so your browser never contacts them
          directly.
        </li>
        <li>
          <strong className="text-ink">Vercel</strong>, which hosts and serves
          the site and necessarily handles requests to it.
        </li>
      </ul>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        Nobody else. We do not sell data, share it with advertisers or data
        brokers, or pass it to any third party beyond those two processors.
      </p>

      <SectionRule label="How long it is kept" />
      <ul className="space-y-2 text-base leading-relaxed text-ink-soft">
        <li>
          <strong className="text-ink">Analytics events: one year</strong>, the
          retention configured on our analytics project, after which they are
          deleted by the processor.
        </li>
        <li>
          <strong className="text-ink">Rate-limit counters: minutes.</strong>{" "}
          They live in the memory of the serving process, are never written to
          disk, and are discarded whenever the site is redeployed.
        </li>
        <li>
          <strong className="text-ink">Benchmark measurements: indefinitely</strong>,
          because they describe infrastructure providers rather than visitors
          and contain no personal data.
        </li>
      </ul>

      <SectionRule label="What you can turn off" />
      <ul className="space-y-2 text-base leading-relaxed text-ink-soft">
        <li>
          Analytics can be blocked in your browser, or by any content blocker,
          or by enabling Do Not Track. Nothing on the site stops working.
        </li>
        <li>
          Clearing your browser storage removes the random device identifier,
          and the next visit starts a new one.
        </li>
        <li>
          Because we hold no name, email or account, we cannot look up, export
          or delete &ldquo;your&rdquo; records on request: there is nothing
          tying them to you. If you believe we hold something about you, write
          to{" "}
          <a href={`mailto:${SITE.email}`} className="underline underline-offset-4">
            {SITE.email}
          </a>{" "}
          and we will look.
        </li>
      </ul>

      <SectionRule label="The MCP server and AI assistants" />
      <p className="text-base leading-relaxed text-ink-soft">
        The Model Context Protocol endpoint at{" "}
        <code>{SITE.url}/api/mcp/mcp</code> is public, read-only and requires no
        authentication or account. It answers questions about published
        benchmark data and stores nothing about the conversation that reached
        it. A question containing something that looks like a credential is
        redacted before it appears anywhere in the response.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        When you reach this data through an AI assistant, that assistant has its
        own privacy policy covering your conversation. We receive the question
        it chooses to send us and nothing else.
      </p>

      <SectionRule label="Children" />
      <p className="text-base leading-relaxed text-ink-soft">
        This is a technical reference for people choosing infrastructure
        providers. It is not directed at children, and we do not knowingly
        collect anything from them.
      </p>

      <SectionRule label="Changes, and contact" />
      <p className="text-base leading-relaxed text-ink-soft">
        This page changes in public commits like the rest of the site, in the
        same change that alters what is collected. Questions and corrections to{" "}
        <a href={`mailto:${SITE.email}`} className="underline underline-offset-4">
          {SITE.email}
        </a>
        . See also the{" "}
        <Link href="/terms" className="underline underline-offset-4">
          terms of use
        </Link>{" "}
        and the{" "}
        <Link href="/methodology" className="underline underline-offset-4">
          methodology
        </Link>
        .
      </p>
    </article>
  );
}
