import type { Metadata } from "next";
import Link from "next/link";
import { SectionRule } from "@/components/section-rule";
import { SITE } from "@/data/site";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  path: "/privacy",
  title: "Privacy",
  description:
    "What OpenChainBench collects: anonymous analytics, no accounts, no personal data, no advertising. Written from the code that runs the site.",
});

/**
 * Privacy policy.
 *
 * Required to list the MCP server in the ChatGPT app directory (a Privacy
 * Policy URL is a mandatory submission field), and it did not exist: both
 * /privacy and /terms answered 404 on production.
 *
 * Every claim below is read off the code rather than drafted from a
 * template, because a policy that overstates what we collect is as wrong as
 * one that understates it:
 *   - `src/components/posthog-provider.tsx:57-64` sets `autocapture: false`,
 *     `capture_pageview: false` (pageviews are sent manually per route) and
 *     `person_profiles: "identified_only"`. Nothing in the codebase ever
 *     calls `posthog.identify`, so no person profile is ever created.
 *   - `api_host: "/ingest"` proxies analytics through our own origin, so the
 *     browser never talks to a third-party analytics host directly.
 *   - `src/lib/analytics-server.ts:72` derives the server-side id as
 *     sha256(user-agent + UTC day) and sets `$process_person_profile: false`;
 *     no IP is stored.
 *   - `src/lib/rate-limit.ts:21` keeps rate-limit buckets in an in-memory
 *     Map keyed by IP. It is process-local, never written to disk, and lost
 *     on every deploy.
 * If any of those change, this page changes in the same commit.
 */
export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
      <header className="border-b-2 border-ink pb-6">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">Privacy</h1>
        <p className="mt-3 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
          OpenChainBench has no accounts, no sign-in and no payments. It
          measures infrastructure, not people.
        </p>
      </header>

      <SectionRule label="The short version" />
      <p className="text-base sm:text-lg leading-relaxed text-ink-soft">
        We collect anonymous, aggregate usage statistics so we know which
        benchmarks are read. We do not ask for your name, your email or your
        wallet, we do not sell or share data with advertisers, and we have no
        way to work out who you are from what we store.
      </p>

      <SectionRule label="What we collect" />
      <p className="text-base leading-relaxed text-ink-soft">
        Page analytics run on PostHog, proxied through this site&rsquo;s own
        origin so your browser never contacts a third-party analytics host
        directly. Automatic event capture is switched off: we record a
        pageview per route, a page-leave event, and three deliberate
        interactions (an outbound link click, a copy, a search). Each visit is
        tied to a random identifier stored in your browser, never to an
        identity. User profiles are disabled in our configuration and the code
        never calls the function that would create one.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        A small number of machine-readable surfaces are counted on the server
        instead, because no browser renders them: the Markdown views,{" "}
        <code>/api/stat</code> and <code>/api/citable</code>. There the
        identifier is a daily hash of the requesting user agent. No IP address
        is stored.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        Public endpoints are rate limited per IP address. Those counters live
        in memory in the serving process, are never written to disk, and are
        discarded whenever the site is redeployed.
      </p>

      <SectionRule label="What we do not collect" />
      <ul className="space-y-2 text-base leading-relaxed text-ink-soft">
        <li>No accounts, passwords or email addresses, because there is nothing to sign in to.</li>
        <li>No wallet addresses, private keys or API keys. Never send us one.</li>
        <li>No advertising or cross-site tracking identifiers, and no data sold or shared with data brokers.</li>
        <li>No session recordings, heatmaps or form capture.</li>
      </ul>

      <SectionRule label="The MCP server and AI assistants" />
      <p className="text-base leading-relaxed text-ink-soft">
        The Model Context Protocol endpoint at{" "}
        <code>{SITE.url}/api/mcp/mcp</code> is public, read-only and requires
        no authentication or account. It answers questions about published
        benchmark data. It stores nothing about the conversation that reached
        it: requests are served and dropped, with only the same anonymous
        aggregate counting described above.
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        When you reach this data through an AI assistant, that assistant has
        its own privacy policy covering your conversation. We receive the
        question your assistant chooses to send us and nothing else.
      </p>

      <SectionRule label="Data we publish" />
      <p className="text-base leading-relaxed text-ink-soft">
        Benchmark measurements are published openly under CC-BY-4.0. They
        describe infrastructure providers, not visitors, and contain no
        personal data. Methodology and raw harness code are public in the{" "}
        <a href={SITE.github} className="underline underline-offset-4">
          repository
        </a>
        .
      </p>

      <SectionRule label="Your rights, and contact" />
      <p className="text-base leading-relaxed text-ink-soft">
        Because we hold no identifying data, we cannot look up, export or
        delete &ldquo;your&rdquo; records. You can stop the anonymous
        analytics at any time by blocking them in your browser or enabling Do
        Not Track. If you believe we hold something about you, or you want
        anything on this page clarified, write to{" "}
        <a href={`mailto:${SITE.email}`} className="underline underline-offset-4">
          {SITE.email}
        </a>
        .
      </p>
      <p className="mt-4 text-base leading-relaxed text-ink-soft">
        See also the{" "}
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
