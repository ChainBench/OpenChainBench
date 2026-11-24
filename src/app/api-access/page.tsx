import Link from "next/link";
import { AccessRequestForm } from "@/components/access-request-form";
import { CodeSnippet } from "@/components/code-snippet";
import { SectionRule } from "@/components/section-rule";
import { SITE } from "@/data/site";
import {
  KEYED_PER_MINUTE,
  REQUEST_PAGE_PATH,
} from "@/lib/api-access/contract";
import {
  KEYED_CACHE_NOTE,
  KEYED_EXCEPTIONS,
  PER_SERVER_NOTE,
  PUBLIC_RANGE,
} from "@/lib/api-access/public-limits";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: import("next").Metadata = pageMetadata({
  path: REQUEST_PAGE_PATH,
  title: "API access",
  description:
    "Request a free OpenChainBench API key to show benchmark numbers on " +
    "your own site. A person reviews each request.",
});

const FACTS = [
  {
    term: "Without a key",
    value: PUBLIC_RANGE,
    unit: "requests per minute per route, per IP",
  },
  {
    term: "With a key",
    value: String(KEYED_PER_MINUTE),
    unit: "requests per minute per route, per key",
  },
  {
    term: "Price",
    value: "Free",
    unit: "for every approved request",
  },
] as const;

const EXAMPLE =
  `curl ${SITE.url}/api/stat/ethereum-rpc \\\n` +
  `  -H "Authorization: Bearer $OCB_API_KEY"`;

const FACT_GRID =
  "grid gap-px overflow-hidden rounded-lg border border-rule bg-rule " +
  "sm:grid-cols-3";

export default function ApiAccessPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="display text-4xl text-ink sm:text-5xl">API access</h1>
      <p className="mt-5 text-[17px] leading-relaxed text-ink-soft">
        Show OpenChainBench numbers on your own site. The public API works
        without a key; a key raises your limit and tells us who to warn before
        an endpoint changes.
      </p>

      <SectionRule label="What a key changes" />
      <dl className={FACT_GRID}>
        {FACTS.map((fact) => (
          <div key={fact.term} className="bg-paper px-4 py-3">
            <dt className="label-mono-xs font-medium text-ink-muted">
              {fact.term}
            </dt>
            <dd className="mt-1 text-sm text-ink-soft">
              <span className="display mr-1 text-xl text-ink">
                {fact.value}
              </span>
              {fact.unit}
            </dd>
          </div>
        ))}
      </dl>
      <CodeSnippet label="Example call with a key">{EXAMPLE}</CodeSnippet>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">
        With a key, the limit is {KEYED_EXCEPTIONS}, whose answers cost
        more to build. {PER_SERVER_NOTE} {KEYED_CACHE_NOTE} Call the API
        from your server: a key placed in browser code can be read by
        anyone.
        Endpoints are listed in the{" "}
        <Link className="lnk" href="/docs#rest">
          API reference
        </Link>
        .
      </p>

      <AccessRequestForm contactEmail={SITE.email} />
    </div>
  );
}
