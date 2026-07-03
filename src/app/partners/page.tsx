import Link from "next/link";
import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { SITE } from "@/data/site";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";

/**
 * Partners and integrations page. Documents the public assets a provider,
 * tool, or media outlet can drop into their own surfaces to surface
 * OpenChainBench measurements: live badges, share cards, citation
 * snippets, and the public data endpoints (REST, OpenAPI, MCP, llms.txt).
 *
 * Purpose is twofold:
 *   1. Reduce friction for sites that already want to cite us. Every
 *      asset on this page is meant to be copied and dropped in with no
 *      back-and-forth.
 *   2. Surface the CC-BY-4.0 license clearly so legal teams have an easy
 *      answer when their content team asks "can we embed this badge?".
 */

const DESCRIPTION =
  "Live badges, share cards and data APIs to embed OpenChainBench measurements on your README, docs or site. CC-BY-4.0.";

export const metadata: Metadata = pageMetadata({
  path: "/partners",
  title: "Partners and integrations",
  description: DESCRIPTION,
});

export const revalidate = 3600;

export default function PartnersPage() {
  const breadcrumbLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Partners", item: `${SITE.url}/partners` },
    ]),
  };

  return (
    <article className="mx-auto max-w-3xl px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />

      <p
        className="label-mono text-[10px] text-ink-faint mb-2"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        Partners and integrations
      </p>
      <h1 className="display text-3xl sm:text-4xl text-ink leading-tight">
        Embed OpenChainBench measurements anywhere
      </h1>
      <p className="mt-4 text-base sm:text-lg text-ink-soft leading-snug max-w-2xl">
        Every measurement on OpenChainBench is published under the
        Creative Commons Attribution 4.0 license. You can mirror, embed,
        cite and reformat any value as long as the source link points
        back to the benchmark page it came from. The assets below are
        the ones we maintain so you do not have to.
      </p>

      <Section
        title="Live ranking badges"
        slug="badges"
        description="SVG badges that render the live rank + headline figure for one provider on one benchmark. The SVG refreshes on the OpenChainBench CDN every five minutes so an embedded copy stays in sync without any work on your side."
      >
        <Example
          label="Endpoint"
          code={`GET https://openchainbench.com/api/badge/<benchmark-slug>/<provider-slug>`}
        />
        <Example
          label="Direct SVG (example)"
          code={`https://openchainbench.com/api/badge/rpc-capabilities/helius`}
        />
        <Example
          label="Markdown for a README"
          code={`[![OpenChainBench rpc-capabilities ranking for Helius](https://openchainbench.com/api/badge/rpc-capabilities/helius)](https://openchainbench.com/benchmarks/rpc-capabilities)`}
        />
        <Example
          label="HTML embed"
          code={`<a href="https://openchainbench.com/benchmarks/rpc-capabilities" target="_blank" rel="noopener"><img src="https://openchainbench.com/api/badge/rpc-capabilities/helius" alt="OpenChainBench rpc-capabilities ranking for Helius" /></a>`}
        />
        <p className="mt-3 text-sm text-ink-soft leading-relaxed">
          Optional query params <code className="mono-tag">?chain=</code>,
          {" "}<code className="mono-tag">?region=</code> and
          {" "}<code className="mono-tag">?kind=</code> scope the rank to
          a single cell when the benchmark publishes a chain x region
          ranking matrix. The badge prints the scope as a subscript so a
          reader never reads a chain-scoped #1 as a global finish.
        </p>
        <p className="mt-2 text-sm text-ink-soft leading-relaxed">
          Need a copy-paste string instead of a URL? Append
          {" "}<code className="mono-tag">/snippet?format=markdown</code> (or
          {" "}<code className="mono-tag">html</code>,{" "}
          <code className="mono-tag">url</code>,{" "}
          <code className="mono-tag">json</code>) to the badge endpoint
          and the server returns the formatted snippet directly.
        </p>
      </Section>

      <Section
        title="Share cards (1200 x 630)"
        slug="share-cards"
        description="High-resolution PNG poster of any benchmark. Five layouts: full ranking, leaderboard, 24h chart snapshot, single-provider headline, two-provider compare. Each is rendered server-side from React, so the values are always the most recent ones the benchmark holds at request time."
      >
        <Example
          label="Endpoint"
          code={`GET https://openchainbench.com/benchmarks/<benchmark-slug>/share-card?template=<layout>`}
        />
        <p className="mt-3 text-sm text-ink-soft leading-relaxed">
          Templates accepted: <code className="mono-tag">ranking</code>,{" "}
          <code className="mono-tag">leaderboard</code>,{" "}
          <code className="mono-tag">snapshot</code>,{" "}
          <code className="mono-tag">headline</code>,{" "}
          <code className="mono-tag">compare</code>. Each benchmark page
          ships with a Share dialog that previews every template and
          downloads the PNG, so you can pick visually if the URL form is
          not your preference.
        </p>
      </Section>

      <Section
        title="Citation snippets"
        slug="citations"
        description="Plain-text quotes and pre-formatted headline sentences for journalists, researchers and LLMs that need a one-liner with the source link baked in."
      >
        <Example
          label="Per-benchmark JSON"
          code={`GET https://openchainbench.com/api/stat/<benchmark-slug>`}
        />
        <Example
          label="Full index"
          code={`GET https://openchainbench.com/api/citable`}
        />
        <p className="mt-3 text-sm text-ink-soft leading-relaxed">
          Each <code className="mono-tag">/api/stat</code> response
          carries a ready-to-paste headline sentence and a citation quote
          with the canonical bench URL embedded. The citation index
          covers every live benchmark in a single response so an LLM or
          aggregator can ingest the catalog in one call.
        </p>
      </Section>

      <Section
        title="Public data APIs"
        slug="apis"
        description="REST endpoints and an MCP server expose the raw rankings, sparkline series, methodology and provider metadata. Same data the OCB site renders, no scraping required."
      >
        <Example
          label="OpenAPI"
          code={`GET https://openchainbench.com/api/openapi.json`}
        />
        <Example
          label="MCP server (Streamable HTTP)"
          code={`https://openchainbench.com/api/mcp/mcp`}
        />
        <Example
          label="LLM-ready context dump (~80 KB markdown)"
          code={`GET https://openchainbench.com/api/llm-context`}
        />
        <Example label="llms.txt index" code={`https://openchainbench.com/llms.txt`} />
      </Section>

      <Section
        title="License"
        slug="license"
        description="Every measurement on this site is published under Creative Commons Attribution 4.0 International. You can mirror, transform, embed and quote the data freely as long as the source link points back to the benchmark page it came from."
      >
        <p className="text-sm text-ink-soft leading-relaxed">
          Full license text:{" "}
          <a
            className="lnk"
            href="https://creativecommons.org/licenses/by/4.0/"
            target="_blank"
            rel="noopener"
          >
            creativecommons.org/licenses/by/4.0
          </a>
        </p>
      </Section>

      <Section
        title="Talk to us"
        slug="contact"
        description="If you are integrating OpenChainBench in a product, a research note, or a comparison page and want methodology coverage notes, custom variant URLs, or anything more involved, we are happy to coordinate."
      >
        <p className="text-sm text-ink-soft leading-relaxed">
          Email{" "}
          <a className="lnk" href="mailto:contact@openchainbench.com">
            contact@openchainbench.com
          </a>{" "}
          or DM{" "}
          <a
            className="lnk"
            href="https://x.com/OpenChainBench"
            target="_blank"
            rel="noopener"
          >
            @OpenChainBench
          </a>{" "}
          on X. Source code lives on{" "}
          <a
            className="lnk"
            href="https://github.com/ChainBench/OpenChainBench"
            target="_blank"
            rel="noopener"
          >
            GitHub
          </a>
          .
        </p>
      </Section>

      <p className="mt-12 text-[11px] text-ink-faint italic">
        Looking for the full benchmark catalog?{" "}
        <Link className="underline" href="/benchmarks">
          /benchmarks
        </Link>{" "}
        lists every live measurement. The{" "}
        <Link className="underline" href="/methodology">
          methodology
        </Link>{" "}
        page documents how each headline figure is computed.
      </p>
    </article>
  );
}

function Section({
  title,
  slug,
  description,
  children,
}: {
  title: string;
  slug: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="mt-10" id={slug}>
      <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink">
        {title}
      </h2>
      <p className="mt-2 text-sm text-ink-soft leading-relaxed max-w-2xl">
        {description}
      </p>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function Example({ label, code }: { label: string; code: string }) {
  return (
    <div>
      <p
        className="label-mono text-[10px] text-ink-faint mb-1 uppercase tracking-wide"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {label}
      </p>
      <pre
        className="rounded-md border border-ink/15 bg-paper-soft/40 px-3 py-2 text-[12px] overflow-x-auto"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
