import type { Metadata } from "next";
import Link from "next/link";
import { SITE } from "@/data/site";
import { buildItemListJsonLd, safeJsonLd } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/page-metadata";
import { isDevOnlyRoute } from "@/lib/removed-benches";

const TITLE = "Interactive tools: perp costs and RPC latency";
const DESCRIPTION =
  "Calculators on OpenChainBench measurements: what a leveraged perp trade costs across ten venues, what two venues charge, how fast an RPC answers.";

export const metadata: Metadata = pageMetadata({
  path: "/tools",
  title: TITLE,
  description: DESCRIPTION,
});

/**
 * A tool takes the reader's own numbers and answers a question about them. A
 * benchmark ranks a cohort on one measurement; these do not rank anything, so
 * they do not belong under /benchmarks.
 *
 * `route` is matched against the dev-only gate, so a tool whose data only
 * exists on staging disappears here instead of linking to a page production
 * does not serve.
 */
const TOOLS: Array<{
  href: string;
  name: string;
  what: string;
  input: string;
}> = [
  {
    href: "/tools/perp-cost",
    name: "Perp leverage cost",
    what: "What ten perp venues take from the same leveraged trade, and the price move where a fee charged on the gain beats a fee charged on notional.",
    input: "Margin, leverage, market, price move",
  },
  {
    href: "/fee-compare",
    name: "Perp fee comparison",
    what: "Taker rates between any two perp venues, and, with a wallet address, what a real trade history would have cost on the other one.",
    input: "Two venues, optionally a wallet",
  },
  {
    href: "/speedtest-rpc",
    name: "RPC speed test",
    what: "Runs the same JSON-RPC calls we benchmark from your own browser, so the latency you read is measured from where you sit.",
    input: "A chain, your connection",
  },
  {
    href: "/rpc-map",
    name: "RPC latency map",
    what: "Where each public RPC endpoint answers quickly and where it does not, built from the speed test's contributions.",
    input: "A chain, a provider",
  },
];

export default function ToolsPage() {
  const tools = TOOLS.filter((t) => !isDevOnlyRoute(t.href));

  const jsonLd = buildItemListJsonLd({
    name: "OpenChainBench tools",
    url: `${SITE.url}/tools`,
    description: DESCRIPTION,
    items: tools.map((t) => ({
      name: t.name,
      url: `${SITE.url}${t.href}`,
      description: t.what,
    })),
    breadcrumb: [
      { name: "Home", url: SITE.url },
      { name: "Tools", url: `${SITE.url}/tools` },
    ],
  });

  return (
    <article className="mx-auto max-w-[860px] px-4 py-10 sm:px-6 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />

      <p className="mb-3 font-sans text-[11px] uppercase tracking-[0.18em] text-ink-faint">
        Tools
      </p>
      <h1 className="display text-3xl leading-[1.05] text-ink sm:text-4xl">
        Tools that take your numbers
      </h1>
      <p className="mt-4 max-w-2xl text-base leading-snug text-ink-soft">
        A benchmark ranks a cohort on one measurement. These do something else: you give them your
        position, your wallet or your connection, and they answer for that. They run on the same
        measurements and the same methodology as the{" "}
        <Link href="/benchmarks" className="underline">
          benchmarks
        </Link>
        , and each one says where its numbers came from.
      </p>

      <ul className="mt-8 grid gap-4">
        {tools.map((tool) => (
          <li key={tool.href}>
            <Link
              href={tool.href}
              className="block rounded-2xl border border-rule bg-surface p-5 transition-colors hover:border-rule-strong sm:p-6"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2 className="display text-xl text-ink">{tool.name}</h2>
                <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-faint">
                  {tool.input}
                </p>
              </div>
              <p className="mt-2 text-sm leading-snug text-ink-soft">{tool.what}</p>
            </Link>
          </li>
        ))}
      </ul>
    </article>
  );
}
